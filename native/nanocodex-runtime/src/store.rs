//! A Postgres host for nanocode's `SqlStore`.
//!
//! nanocode's SQL store sends every parameter as text and reads every column
//! as optional text, so this host binds parameters as `TEXT` and decodes
//! columns as `Option<String>`. Sessions live in their own `nanocode` schema so
//! nanocode's unprefixed tables (`states`, `records`, ...) never meet the
//! application's.

use std::sync::atomic::{AtomicUsize, Ordering};

use nanocode::durability::{Sql, SqlDialect, SqlRow, SqlStatement, StoreError, StoreFuture};
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls, types::Type};

pub const SCHEMA: &str = "nanocode";

pub struct PostgresHost {
    url: String,
    clients: Vec<Mutex<Option<Client>>>,
    next: AtomicUsize,
}

impl PostgresHost {
    /// Connects one client, creates the schema, and keeps `size` lazily
    /// (re)connected clients for transactions.
    pub async fn connect(url: &str, size: usize) -> Result<Self, StoreError> {
        let host = Self {
            url: url.to_owned(),
            clients: (0..size.max(1)).map(|_| Mutex::new(None)).collect(),
            next: AtomicUsize::new(0),
        };
        let client = open(&host.url, false).await?;
        client
            .batch_execute(&format!("CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
            .await
            .map_err(backend)?;
        Ok(host)
    }

    async fn run_on(
        &self,
        statements: &[SqlStatement<'_>],
    ) -> Result<Vec<Vec<SqlRow>>, StoreError> {
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.clients.len();
        let mut slot = self.clients[index].lock().await;
        if slot.as_ref().is_none_or(Client::is_closed) {
            *slot = Some(open(&self.url, true).await?);
        }
        let client = slot.as_mut().expect("client was just connected");
        let transaction = client.transaction().await.map_err(backend)?;
        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            let params: Vec<(&(dyn tokio_postgres::types::ToSql + Sync), Type)> = statement
                .params
                .iter()
                .map(|param| {
                    (
                        param as &(dyn tokio_postgres::types::ToSql + Sync),
                        Type::TEXT,
                    )
                })
                .collect();
            let rows = transaction
                .query_typed(statement.sql, &params)
                .await
                .map_err(backend)?;
            let rows = rows
                .iter()
                .map(|row| {
                    (0..row.len())
                        .map(|column| row.try_get::<_, Option<String>>(column))
                        .collect::<Result<SqlRow, _>>()
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(backend)?;
            results.push(rows);
        }
        transaction.commit().await.map_err(backend)?;
        Ok(results)
    }
}

impl Sql for PostgresHost {
    fn transaction<'a>(
        &'a self,
        _operation: &'static str,
        statements: &'a [SqlStatement<'a>],
    ) -> StoreFuture<'a, Result<Vec<Vec<SqlRow>>, StoreError>> {
        Box::pin(self.run_on(statements))
    }

    fn dialect(&self) -> SqlDialect {
        SqlDialect::Postgres
    }

    fn writers(&self) -> usize {
        self.clients.len()
    }

    fn readers(&self) -> usize {
        self.clients.len()
    }
}

async fn open(url: &str, scoped: bool) -> Result<Client, StoreError> {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await.map_err(backend)?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("nanocode store connection closed: {error}");
        }
    });
    if scoped {
        client
            .batch_execute(&format!("SET search_path TO {SCHEMA}"))
            .await
            .map_err(backend)?;
    }
    Ok(client)
}

fn backend(error: tokio_postgres::Error) -> StoreError {
    // The default display is just "db error"; keep Postgres's own message.
    StoreError::Backend(match error.as_db_error() {
        Some(db) => format!("{}: {}", db.code().code(), db.message()),
        None => error.to_string(),
    })
}

import ts from "typescript";

export function isTypeOnlyTypescriptSource(sourceText: string, filename = "source.ts"): boolean {
  const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return source.statements.every(isErasedTypeStatement);
}

function isErasedTypeStatement(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (hasDeclareModifier(statement)) return true;

  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    return Boolean(
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    );
  }

  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return true;
    if (statement.moduleSpecifier) return false;
    if (!statement.exportClause) return true;
    return ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.every((element) => element.isTypeOnly);
  }

  return false;
}

function hasDeclareModifier(statement: ts.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) return false;
  return Boolean(ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword));
}

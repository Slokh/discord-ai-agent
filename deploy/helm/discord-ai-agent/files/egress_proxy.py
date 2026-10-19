"""Sandbox egress policy and credential injection for mitmproxy.

Every tunnel is limited to public port-443 destinations. The proxy resolves the
target itself, refuses any non-global or explicitly denied address, and pins
the connection to the checked address so DNS rebinding cannot redirect it.

Each listener owns a fixed credential set: the credentialed listener injects
OpenRouter and GitHub, the model listener injects only OpenRouter (using the
spend-capped sandbox key when configured), and any other listener injects
nothing. A connection is intercepted only when its CONNECT host and TLS SNI
both name a host in its listener's set. There, a placeholder in the
Authorization header is replaced with the real credential before the request
continues over verified TLS. Every other connection is an opaque passthrough
tunnel, so sandboxes see the real certificate and no credential is added.
"""

import asyncio
import base64
import ipaddress
import json
import logging
import os
import socket
import ssl
import threading
import time
import urllib.request
from datetime import datetime

import certifi
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from mitmproxy import http, tls
from mitmproxy.proxy import server_hooks

log = logging.getLogger("discord_ai_agent.egress")

ALLOWED_PORT = 443


def _csv(name: str) -> list[str]:
    return [value.strip().lower() for value in os.environ.get(name, "").split(",") if value.strip()]


def _host(value: str | None) -> str:
    return (value or "").strip().lower().rstrip(".")


DENY_NETWORKS = [ipaddress.ip_network(cidr) for cidr in _csv("EGRESS_DENY_CIDRS")]
CREDENTIALED_PORT = int(os.environ["EGRESS_CREDENTIALED_PORT"])
MODEL_PORT = int(os.environ["EGRESS_MODEL_PORT"])


def _public(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return ip.is_global and not ip.is_multicast and not any(ip in network for network in DENY_NETWORKS)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class GitHubCredential:
    """Mirrors src/github/appToken.ts: a repository-scoped App installation
    token when App credentials exist, otherwise the static token."""

    def __init__(self) -> None:
        self.static_token = os.environ.get("GITHUB_TOKEN", "")
        self.app_id = os.environ.get("GITHUB_APP_ID", "")
        self.private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY", "").replace("\\n", "\n")
        self.installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID", "")
        self.repository = os.environ.get("GITHUB_REPOSITORY", "")
        self.lock = threading.Lock()
        self.cached: tuple[str, float] | None = None

    def value(self) -> str:
        if not (self.app_id and self.private_key and self.installation_id):
            return self.static_token
        with self.lock:
            if self.cached and self.cached[1] - time.time() > 300:
                return self.cached[0]
            self.cached = self._installation_token()
            return self.cached[0]

    def _installation_token(self) -> tuple[str, float]:
        now = int(time.time())
        header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
        payload = _b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": self.app_id}).encode())
        key = serialization.load_pem_private_key(self.private_key.encode(), password=None)
        signature = key.sign(f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256())
        repository = self.repository.split("/", 1)[1]
        request = urllib.request.Request(
            f"https://api.github.com/app/installations/{self.installation_id}/access_tokens",
            data=json.dumps({"repositories": [repository]}).encode(),
            method="POST",
            headers={
                "accept": "application/vnd.github+json",
                "authorization": f"Bearer {header}.{payload}.{_b64url(signature)}",
                "content-type": "application/json",
                "user-agent": "discord-ai-agent-egress-proxy",
            },
        )
        context = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(request, timeout=20, context=context) as response:
            data = json.load(response)
        expires_at = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00")).timestamp()
        return data["token"], expires_at


class Credential:
    def __init__(self, name: str, hosts: list[str], placeholder: str, value) -> None:
        self.name = name
        self.hosts = set(hosts)
        self.placeholder = placeholder
        self.value = value


def _swap(header: str, placeholder: str, secret: str) -> str | None:
    if placeholder in header:
        return header.replace(placeholder, secret)
    scheme, _, parameter = header.partition(" ")
    if scheme.lower() != "basic" or not parameter.strip():
        return None
    try:
        decoded = base64.b64decode(parameter.strip(), validate=True).decode()
    except ValueError:
        return None
    if placeholder not in decoded:
        return None
    return f"{scheme} {base64.b64encode(decoded.replace(placeholder, secret).encode()).decode()}"


class EgressProxy:
    def __init__(self) -> None:
        github = GitHubCredential()
        openrouter_hosts = _csv("EGRESS_OPENROUTER_HOSTS")
        openrouter_placeholder = os.environ["EGRESS_OPENROUTER_PLACEHOLDER"]
        openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
        # Untrusted programs share the model listener's pods, so it prefers a
        # separately spend-capped key and never carries GitHub.
        model_key = os.environ.get("SANDBOX_OPENROUTER_API_KEY", "") or openrouter_key
        self.listeners = {
            CREDENTIALED_PORT: [
                Credential("openrouter", openrouter_hosts, openrouter_placeholder, lambda: openrouter_key),
                Credential("github", _csv("EGRESS_GITHUB_HOSTS"), os.environ["EGRESS_GITHUB_PLACEHOLDER"], github.value),
            ],
            MODEL_PORT: [
                Credential("openrouter-sandbox", openrouter_hosts, openrouter_placeholder, lambda: model_key),
            ],
        }

    def _credential(self, listener: int | None, host: str) -> Credential | None:
        credentials = self.listeners.get(listener, []) if listener is not None else []
        return next((credential for credential in credentials if host in credential.hosts), None)

    def http_connect(self, flow: http.HTTPFlow) -> None:
        if flow.request.port != ALLOWED_PORT:
            log.warning("egress denied: CONNECT to port %s", flow.request.port)
            flow.response = http.Response.make(403, b"Sandbox egress allows HTTPS on port 443 only.\n")

    async def server_connect(self, data: server_hooks.ServerConnectionHookData) -> None:
        host, port = data.server.address
        if port != ALLOWED_PORT:
            data.server.error = "Sandbox egress allows HTTPS on port 443 only."
            return
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
        except OSError:
            data.server.error = f"Cannot resolve {host}."
            return
        addresses = sorted({info[4][0] for info in infos})
        if not addresses or not all(_public(address) for address in addresses):
            log.warning("egress denied: %s resolves to a non-public address", host)
            data.server.error = f"{host} resolves to a non-public address."
            return
        data.server.address = (addresses[0], port)

    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        sni = _host(data.client_hello.sni)
        target = _host(data.context.server.address[0]) if data.context.server.address else ""
        listener = data.context.client.sockname[1] if data.context.client.sockname else None
        if not sni or sni != target or self._credential(listener, sni) is None:
            data.ignore_connection = True

    async def requestheaders(self, flow: http.HTTPFlow) -> None:
        if flow.request.scheme != "https":
            flow.response = http.Response.make(403, b"Sandbox egress allows HTTPS only.\n")
            return
        sni = _host(flow.client_conn.sni)
        listener = flow.client_conn.sockname[1] if flow.client_conn.sockname else None
        credential = self._credential(listener, sni)
        if credential is None or _host(flow.request.pretty_host) != sni:
            return
        header = flow.request.headers.get("authorization")
        if not header or _swap(header, credential.placeholder, credential.placeholder) is None:
            return
        try:
            secret = await asyncio.to_thread(credential.value)
        except Exception:
            log.exception("egress credential %s unavailable", credential.name)
            secret = ""
        if not secret:
            flow.response = http.Response.make(502, b"Sandbox egress credential is unavailable.\n")
            return
        swapped = _swap(header, credential.placeholder, secret)
        if swapped is not None:
            flow.request.headers["authorization"] = swapped


addons = [EgressProxy()]

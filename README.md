# HDUD Core API

HDUD Core is the foundational backend of the **Histórias de um Desconhecido (HDUD)** platform.
It provides a secure, Unicode-safe, versioned and auditable API for human memories.

---

## ✨ Features

- Node.js (ESM) + Express
- SQL Server backend
- JWT Authentication (Bearer)
- Unicode-safe end-to-end (UTF-8 / NVARCHAR)
- Memory versioning
- Event ledger (audit trail)
- Rollback by version
- Timeline per memory
- Hardened server (Helmet, CORS, Rate Limit)
- OpenAPI (Swagger) as source of truth
- Smoke test for regression validation

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- pnpm
- SQL Server (local or remote)

### Install dependencies
```bash
pnpm install

# byteforce-space-plaid

Local Plaid budgeting app:
- Node/Express backend with SQLite (stores access tokens and cursors)
- Static web frontend that launches Plaid Link
- OAuth-ready redirect page

## Quick start
1) Create server/.env (copy from server/.env.example)
2) Install deps: `cd server && npm install`
3) Run: `npm start` then open http://localhost:8080

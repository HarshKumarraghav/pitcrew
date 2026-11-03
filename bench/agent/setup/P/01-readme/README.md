# taskboard

Tiny in-memory task-tracking HTTP API written in TypeScript with zero dependencies.

```sh
npm start   # http://127.0.0.1:3000
npm test
```

## API

| method | path | notes |
|---|---|---|
| GET | /tasks | `?status=` filter, `?page=` / `?pageSize=` (max 100) |
| GET | /tasks/:id | 404 if unknown |
| POST | /tasks | `{ title, status? }` |
| PATCH | /tasks/:id | `{ status }` |
| DELETE | /tasks/:id | 204 on success |

Every task gets a URL-safe `slug` derived from its title.

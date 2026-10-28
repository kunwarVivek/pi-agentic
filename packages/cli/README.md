# pi-agentic-cli

`org`, the operator CLI of agentic-pi: the human control-host tool for the approval inbox,
owner notifications and unit registration. It is a thin admin-token client that talks to `pi-control` over its
Unix socket; the only time it opens `control.db` is the explicit offline `org units sync --db`.

```sh
npm install -g pi-agentic-cli

export ORG_CONTROL_SOCKET=/var/lib/org/control.sock
export ORG_ADMIN_TOKEN_FILE=/var/lib/org/admin.token   # written by pi-control when it has ORG_ADMIN_TOKEN_FILE set

org approvals list                      # open approvals: id, task, owner, question, options, expiry
org approvals approve <id> [choice]     # approve; choice must be one of the approval's options
org approvals deny <id> [choice]

org notifications                       # unacknowledged owner notifications (same as `org notifications list`)
org notifications ack <id>

org units sync <org-root>               # add/update units from every <org-root>/**/unit.json (live daemon, admin-only)
org units sync <org-root> --db <control.db>   # same, writing control.db directly: ONLY while pi-control is stopped
```

Resolving an approval drives the task: approve re-queues it (choice `extend` doubles an exhausted budget
dimension), deny or choice `cancel` cancels it and returns its budget reservation to the parent.

## Configuration

| Variable | Meaning |
|---|---|
| `ORG_CONTROL_SOCKET` | required: the shared control socket |
| `ORG_ADMIN_TOKEN_FILE` | file holding the admin token (one of the two is required) |
| `ORG_ADMIN_TOKEN` | the token itself; overrides the file |

The admin token sees every owner's inbox, so keep the token file mode 600 and readable only by the operator. Exit
codes: 0 success, 2 usage error, 1 on a connection or authentication failure.

## Library

`runApprovals(inbox, argv)`, `runNotifications(inbox, argv)` and `runUnits(argv, open)` are exported pure command
cores (they return `{ lines, exitCode }`), as are `formatApproval`, `formatNotification`, `collectManifests` and
`formatSyncReport`.

Requires Node >= 24. License: MIT.

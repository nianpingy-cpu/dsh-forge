# @dsh-forge/plugin-docker

Typed Docker adapter: status, containers, images, inspect, logs, compose
status, build, and compose up/down.

## Installation

```bash
pnpm add @dsh-forge/plugin-docker
```

## Requirements

- Node.js >= 20
- `docker` binary on PATH — install Docker (Desktop or Engine):
  <https://docs.docker.com/engine/install/>

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `docker_status` | read | — |
| `docker_ps` | read | `all?: boolean` |
| `docker_images` | read | — |
| `docker_inspect` | read | `name: string` (required) |
| `docker_logs` | read | `name: string` (required), `tail?: number` (default 100) |
| `docker_compose_status` | read | `path?` |
| `docker_build` | system-change | `tag: string` (required), `path?` |
| `docker_compose_up` | system-change | `path?` |
| `docker_compose_down` | system-change | `path?` |

## Result schema

Read tools return JSON arrays/objects as raw output. Build/compose tools
return raw output only.

## Permission behavior

- Status/ps/images/inspect/logs/compose-status are `read`.
- `docker_build` / `docker_compose_up` / `docker_compose_down` are
  `system-change` and require explicit permission approval.

## Example

```text
docker_ps(all: true)
  → container list
  → docker_build(tag: "my-app:latest", path: ".")
  → docker_compose_up(path: "docker-compose.yml")
```

## Troubleshooting

- `BinaryNotFound`: install Docker and ensure `docker` is on PATH; the daemon
  must be running for most tools.

## Compatibility

Tested against Docker; integration targets the pinned DeepSeek Harness
commit in `compatibility/deepseek-harness.json`.

## License

MIT. Docker remains governed by its upstream license.

# ioBroker Kentix SiteManager Adapter

Adapter for KentixONE SiteManager devices.

The adapter is designed for simple setup: enter the SiteManager IP address and it probes common KentixONE HTTP/REST API endpoints automatically. Every JSON response that is found is mirrored dynamically below `kentix-sitemanager.0.api.*`.

## Features

- Automatic HTTPS/HTTP probing.
- Automatic API endpoint discovery.
- Dynamic ioBroker object tree for all readable JSON data.
- Raw JSON response states below `raw.*`.
- Alarm control states:
  - `control.alarmArmed`
  - `control.alarmMode`
  - `control.armFull`
  - `control.armPartial`
  - `control.disarm`
- Optional username/password or bearer token if the SiteManager requires authentication.

## Configuration

Only `SiteManager IP address` is required for the first test.

Optional:

- `Protocol`: auto, HTTPS or HTTP.
- `Port`: 0 for automatic default port, otherwise fixed port.
- `Username` / `Password`: Basic authentication.
- `API token`: Bearer token authentication.
- `Custom API endpoints`: JSON array or comma/newline list if your KentixONE firmware uses different paths.

## Notes

Kentix firmware/API versions can differ. This adapter therefore mirrors discovered JSON data generically instead of relying on a fixed register list.

The alarm arm/disarm control tries multiple common KentixONE-style REST path variants. If your device rejects all variants, enable debug logging and check `info.lastCommandError`; then add the exact endpoint to the adapter code or provide the API documentation for that firmware.

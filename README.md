# Wordle

Standalone Wordle-style browser game built with static HTML, CSS, and JavaScript.

## Current behavior

- The game loads its runtime word database from `words.json`.
- `words.json` contains category-based five-letter word lists.
- The stored categories are `general`, `food`, `politics`, and `science`.
- The game also builds a virtual `all` category from the union of those lists.
- `all` is the default category unless the player chooses another one in Settings.
- Answer selection comes from the currently selected category.
- Typed guesses are validated against the full virtual `all` category, regardless of the selected answer category.
- Answer selection is random, but the game remembers previously played answers in a cookie and avoids repeats until the full category pool has been used.
- Hints are free-letter hints only; the game no longer uses dictionary definitions.

## Files

- `index.html`: page structure
- `styles.css`: game styling
- `script.js`: game logic
- `words.json`: runtime category-based word database
- `simple-server.sh`: helper script to start, stop, and inspect the background local server
- `scripts/browser-smoke-test.js`: browser smoke test
- `scripts/browser-comprehensive-test.js`: broader browser regression test

## Run locally

Serve the folder over HTTP. The game fetches `words.json`, so opening `index.html` directly from disk is not the intended path.

### Option 1: Use the helper script

```bash
./simple-server.sh start
```

This starts the server in the background, writes its PID to `server.pid`, and appends logs to `server.log`.

It runs:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

Check status with:

```bash
./simple-server.sh status
```

Stop it with:

```bash
./simple-server.sh stop
```

Use a different port or bind address with environment variables:

```bash
PORT=9000 ./simple-server.sh start
BIND_ADDRESS=127.0.0.1 ./simple-server.sh start
```

### Option 2: Start Python manually

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

## Open the game

From the same computer:

```text
http://localhost:8000
```

From another computer on the same network:

```text
http://YOUR_COMPUTER_IP:8000
```

## Test

Run the browser smoke test with:

```bash
make test-browser
```

Run the broader browser regression suite with:

```bash
make test-browser-comprehensive
```

## Notes about LAN access

- `localhost` only works on the machine running the server.
- Binding to `0.0.0.0` allows other devices on your LAN to connect.
- Both computers must be on the same local network unless you set up routing, tunneling, or port forwarding.
- Your firewall may need to allow incoming connections to `python3`.
- The local Python server is only for development and smoke testing, not production deployment.

# Pi Auto Name

A [Pi](https://pi.dev) extension that gives sessions readable names and keeps those names aligned with the conversation.

## How it works

- Assigns an immediate title derived locally from the first user prompt.
- Refines that title after the first completed agent run using conversation history.
- Refreshes the title after every three additional user messages by default.
- Sends only a bounded selection of user and assistant text to the naming model. Tool output and hidden reasoning are excluded.
- Stops managing a session when its name is changed manually with `/name` or from the resume picker.
- Leaves existing manually named sessions untouched.

Refreshes are based on conversation activity rather than wall-clock time, so idle sessions do not make unnecessary model calls.

## Install

```bash
pi install git:github.com/jhlabs/pi-auto-name
```

Restart Pi after installing, or run `/reload` in an existing Pi session.

## Commands

```text
/auto-name           Show status
/auto-name now       Refresh immediately from conversation history
/auto-name on        Enable and adopt the current session
/auto-name off       Stop changing the current session name
/auto-name every 5   Refresh every five additional user messages
```

State is stored in the session JSONL, so manual overrides and refresh cadence survive resume and reload.

## Configuration

Use any authenticated Pi model for title generation:

```bash
pi --auto-name-model provider/model-id
```

The active Pi model is used by default. Change the refresh cadence at startup with:

```bash
pi --auto-name-every 5
```

Naming requests may consume tokens or incur provider costs. Each request uses at most 12,000 characters of bounded conversation history and asks for no more than 96 output tokens.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

Developed against `@earendil-works/pi-coding-agent` 0.84.3.

## License

MIT

# Old-Herdr fallback normalization

The installed Herdr 0.7.5 CLI was invoked with the unsupported accepted-start option and an invalid pane. It exited with status 2 and wrote exactly `unknown option: --wait\n`. The local argument parser rejected the option before server actuation.

The fallback predicate now requires the exact wrapper prefix with status 2. It trims only whitespace after that prefix, then requires the exact message `unknown option: --wait`. It does not accept a near match, another status, or a parsed server error envelope.

Tests cover LF, CRLF and surrounding whitespace, a near match, wrong status, a server envelope, fallback cache behavior, and cleanup. Architecture impact is none.

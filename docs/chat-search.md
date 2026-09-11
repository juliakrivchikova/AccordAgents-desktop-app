# Saved-chat search

The V1 modal search uses SQLite FTS over saved chat titles plus visible, completed user and participant messages. The index is a rebuildable derivative of canonical conversations; it is never the only copy of title or message data.

Queries are normalized into Unicode word tokens and combined with `AND`; only the final token is prefix-matched. Quotation marks and FTS operators are treated as ordinary input, so V1 does not provide exact-phrase search even when the user types quotes.

Every service request carries a requester identity. User requests cover every locally saved chat; participant requests are scoped by stable participant configuration identity and fail closed when that identity or source data cannot be verified. Responses describe the eligible/searched corpus, message period, source snapshot time, and completeness, while the V1 modal intentionally renders only the result and chat counts specified by the design handoff.

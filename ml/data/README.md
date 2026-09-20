Training artifacts that must not be committed:

- `flight_demos/` — Feature C demonstration JSONL (gitignored)
- large replay buffers / SB3 zip checkpoints live in `../iron_glove_rl/models/`

Keep fixtures tiny. The bundled Sentinel policy JSON is exported to
`../../client/public/models/sentinel-policy.json`.

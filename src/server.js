const path = require('path');
const { createServer } = require('./app');

const port = process.env.PORT || 3000;
const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'events.jsonl');
const { server, store } = createServer({ dataFile });
server.listen(port, () => console.log(`LiveBoard on http://localhost:${port}  (replayed ${store.seq} events)`));

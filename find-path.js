const fs = require('fs');
const readline = require('readline');

const logFile = 'C:\\Users\\acer\\.gemini\\antigravity-cli\\brain\\eabf12ab-8b94-44df-9dc4-34064049c77f\\.system_generated\\logs\\transcript.jsonl';

const rl = readline.createInterface({
  input: fs.createReadStream(logFile),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  if (line.includes('settings.json') || line.includes('extension-enablement.json')) {
    const match = line.match(/"TargetFile":"([^"]+)"/g) || line.match(/"AbsolutePath":"([^"]+)"/g) || line.match(/C:\\[^" ]+/g);
    if (match) {
      console.log(match);
    }
  }
});

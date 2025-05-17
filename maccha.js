// proxy.js
// Express server wrapping llama.cpp server with OpenAI function-calling semantics
// Logs client requests/responses and model requests/responses to console

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const TurndownService = require('turndown');
const fs = require('fs');
const path = require('path');

const HOME_DIRECTORY = require('os').homedir();
const PORT = 11434;
const MACCHA_ROOT = __dirname;

// add maccha/bin to PATH (if it is not already in PATH)
const path_env = process.env.PATH.split(':');
if (!path_env.includes(path.join(MACCHA_ROOT, 'bin'))) {
  process.env.PATH = `${path.join(MACCHA_ROOT, 'bin')}:${process.env.PATH}`;
}

// switch to the sandbox directory or ask the user to create it
try {
  process.chdir(path.join(HOME_DIRECTORY, 'maccha'));
} catch (err) {
  console.log('The maccha sandbox directory does not exist. Please create it by running `mkdir ~/maccha`');
  process.exit(1);
}

// create sandbox file as ~/.maccha.sandbox.pf, overwriting if it exists (TODO use HTTP proxy and forbid network access)
fs.writeFileSync(path.join(HOME_DIRECTORY, '.maccha.sandbox.pf'), `(version 1)
(deny default)
(allow sysctl-read)
(allow process-fork)
(allow process-exec)
(allow network*)
(allow file-read*)
(allow file-read-metadata)
(allow file-write* (subpath "${HOME_DIRECTORY}/maccha"))
(deny file-write*)
`);

// In-memory map to track original messages by id
const messageStore = new Map();

// Function definitions
function get_current_time() {
  return { utc: new Date().toISOString() };
}
get_current_time.llm = {
  description: 'returns current time in UTC (+0000)',
  parameters: { type: 'object', properties: {}, required: [] },
};

async function runCommand(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sandbox-exec',
      ['-f', `${HOME_DIRECTORY}/.maccha.sandbox.pf`, 'env', `MACCHA_HOSTPORT=127.0.0.1:${PORT}`, 'bash', '-c', input.cmd]);
    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      resolve(output);
    });
    if (input.stdin != null)
      proc.stdin.write(input.stdin);
    proc.stdin.end();
  });
}
runCommand.llm = {
  description: `Provices access to bash shell on macOS that the user is using.

You can:
* Run arbitrary commands (e.g., ls, cat, curl); outputs to stdout and stderr are returned.
* Use redirects and pipes.
* Write to the current directory (i.e, ${path.join(HOME_DIRECTORY, 'maccha')}); other directories are read-only.

Also, special commands are available:
* \`maccha-activate-app\`: activates a macOS application and optionally simulates a keystroke
* \`maccha-filter\`: an AI agent that processes data and returns the result (can be used to filter data)
* \`maccha-ocr\`: an OCR program that converts images to text
* \`maccha-windowcapture\`: captures the window and saves it as an image

For details, consult \`--help\` of each command.
`,
  parameters: {
    type: 'object',
    properties: {
      cmd: { type: "string", description: "command line"},
      stdin: { type: "string", description: "data to be fed into stdin"},
    },
    required: ["cmd"],
  },
};

async function runBc(input) {
  return runCommand({ cmd: "bc -l", formula: input.stdin });
}
runBc.llm = {
  description: 'calculates formulas and returns the result, by calling the bc command',
  parameters: {
    type: 'object',
    properties: {
      formula: { type: "string", description: "the formula to calculate"},
    },
    required: ["formula"]
  }
};

async function runPython3(input) {
  return runCommand({cmd: 'python3 /dev/stdin', stdin: input.script});
}
runPython3.llm = {
  description: 'Runs given python3 script. Outputs to stdout and stderr are returned. This function is a wrapper of `runCommand`, and therefore shares the same access privledges.',
  parameters: {
    type: 'object',
    properties: {
      script: { type: "string", desription: "python3 script"},
    },
    required: ["script"]
  }
};

async function fetchURL(input) {
  const resp = await fetch(input.url, { method: "GET" });
  let contentType = resp.headers.get("content-type");
  let body = await resp.text();

  if (contentType.match(/^text\/html($|;)/) && input.asMarkdown) {
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    turndown.remove(['script', 'style', 'nav', '.ad-banner'])
    contentType = "text/markdown";
    body = turndown.turndown(body);
  }
  return {"status": resp.status, "content-type": resp.headers.get("content-type"), "body": body};
}

fetchURL.llm = {
  description: "Fetches given URL. Use this tool for scraping",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      asMarkdown: { type: "string", description: "converts HTML to markdown; should be set to true unless the content is needed as-is"},
    },
    required: ["url"]
  }
};

function save_file(input) {
  /* saves input.content to input.path */
  return runCommand({cmd: `cat > ${input.path}`, stdin: input.content});
}

save_file.llm = {
  description: "Saves input.content to input.path",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path to save the file"},
      content: { type: "string", description: "content to be saved"},
    },
    required: ["path", "content"]
  }
};

const functions = Object.fromEntries(
  [
    get_current_time,
    runPython3,
    fetchURL,
    runCommand,
    save_file,
  ].map(def => [def.name, def]));

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

// Expand any message IDs back to full messages
function expandClientMessages(body) {
  if (!Array.isArray(body.messages)) return;
  console.log('Received client messages:', JSON.stringify(body.messages, null, 2));
  body.messages = body.messages.flatMap(m => {
    var recovered = [];
    var match;
    while ((match = m.content.match(/^function-call:([^\n]+)(?:\n(.*)|)$/s)) != null) {
      var id = match[1];
      m.content = match[2] != null ? match[2] : "";
      if (messageStore.has(id))
        recovered.push(...messageStore.get(id));
    }
    recovered.push(m);
    return recovered;
  });
}

async function callLLMJson(body) {
  let messages = body.messages || [];
  const prefixes = [];
  let finalContent = '';
  const headers = {'Content-Type': 'application/json'};
  let endpoint;

  // determine the model to be used, either gpt-* (which means openai) or a custom endpoint (host:port)
  const model = messages.slice().reverse().reduce((acc, m) => {
    if (acc || m.role !== 'user') return acc;
    var match = m.content.match(/\/model:([a-z0-9-\.:]+)\s*$/);
    return match ? match[1] : null;
  }, null) || 'gpt-4.1-mini';
  console.log(`Model message: ${model}`);

  // remove routing insns
  messages = messages.map(m => ({ ...m, content: m.content.replace(/\s*\/(qwen|gpt)\s*$/, "") }));

  while (true) {
    let upstream;
    if (model.match(/^gpt/i)) {
      if (process.env.OPENAI_API_KEY == null) {
        throw new Error("OPENAI_API_KEY is not set");
      }
      endpoint = 'https://api.openai.com/v1/chat/completions';
      headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
      upstream = {
        model: model,
        messages,
        functions: Object.entries(functions).map(([name, fn]) => ({
          name,
          description: fn.llm.description,
          parameters: fn.llm.parameters
        })),
        function_call: 'auto',
        stream: false,
      };
    } else {
      endpoint = `http://${model}/v1/chat/completions`;
      upstream = {
        ...body,
        tools: Object.entries(functions).map(([name, fn]) => ({
          type: 'function',
          function: {
            name,
            description: fn.llm.description,
            parameters: fn.llm.parameters
          }
        })),
        stream: false,
        chat_format: 'chatml-function-calling',
        messages };
    }
    console.log(`Sending to ${endpoint}:`, JSON.stringify(upstream, null, 2));

    const r1 = await axios.post(endpoint, upstream, {headers});
    console.log('Model response:', JSON.stringify(r1.data, null, 2));
    const c1 = r1.data.choices[0];

    let call;
    if (c1.finish_reason === 'tool_calls' && c1.message.tool_calls?.length) {
      // llama.cpp
      call = c1.message.tool_calls[0]['function'];
    } else if (c1.finish_reason === 'function_call') {
      call = c1.message.function_call;
    } else {
      finalContent = c1.message.content;
      break;
    }
    const fn = call.name;
    const args = JSON.parse(call.arguments || '{}');

    console.log(`Calling function ${fn} with args:`, args);
    const resObj = await functions[fn](args);
    console.log(`Function ${fn} result:`, resObj);

    const randId = uuidv4();
    prefixes.push(`function-call:${randId}\n`);

    const fnMsg = { role: 'function', name: fn, content: JSON.stringify(resObj) };

    if (c1.message.content == null)
      c1.message.content = "";
    messageStore.set(randId, [c1.message, fnMsg]);
    messages = [...messages, c1.message, fnMsg];
    continue;
  }

  return [...prefixes, finalContent];
}

app.post('/v1/chat/completions', async (req, res) => {
  try {
    // Expand IDs
    expandClientMessages(req.body);

    const isStream = req.body.stream === true;
    const history = await callLLMJson(req.body);

    console.log('Prepared history for client:', history);
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const emitChunk = (delta) => {
        const chunk = { choices: [{ delta: delta, index: 0, finish_reason: null }]};
        res.write(`data: ${JSON.stringify(chunk)}

`);
      };

      emitChunk({role: "assistant"});
      for (const msg of history) {
        emitChunk({content: msg});
      }
      res.write(`data: [DONE]

`);
      console.log('Stream completed');
      res.end();
    } else {
      const final = history[history.length - 1];
      console.log('Sending non-stream response:', final);
      res.json({ choices: [{ message: final, finish_reason: 'stop' }] });
    }
  } catch (err) {
    console.error('Error in /v1/chat/completions:', err);
    if (req.body.stream) {
      res.write(`event:error
data:${JSON.stringify({ error: err.toString() })}

`);
      res.end();
    } else {
      res.status(500).json({ error: err.toString() });
    }
  }
});

/* Some commands have to be executed out of the sandbox; they call this endpoint. */
app.post('/safe-commands', (req, res) => {
  if (process.env.MACCHA_HOSTPORT) {
    throw new Error('safe commands cannot be run when MACCHA_HOSTPORT is set');
  }
  const { exec, argv, stdin } = req.body;
  if ((exec === 'maccha-ocr' && argv.length === 1) ||
      (exec === 'maccha-windowcapture' && argv.length === 1 && argv[0] === '--base64') ||
      (exec === 'maccha-mp3' && argv.length === 1 && argv[0] === '--base64') ||
      (exec === 'maccha-activate-app')) {
    const proc = spawn(exec, argv);
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk.toString(); });
    proc.stderr.on('data', chunk => { output += chunk.toString(); });
    proc.on('error', err => {
      res.status(500).send(err.message);
    });
    proc.on('close', code => {
      res.status(200).send(output);
    });
    if (stdin != null)
      proc.stdin.write(stdin);
    proc.stdin.end();
  } else {
    res.status(400).send("invalid command or arguments");
  }
});

// serve local files under htdocs
app.use(express.static(`${MACCHA_ROOT}/htdocs`));

// listen
app.listen(PORT, () => console.log(`Proxy listening on ${PORT}`));

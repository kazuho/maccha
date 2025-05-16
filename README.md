Maccha (抹茶)
===

ChatGPT is a powerful tool but since it is a Web-based tool, it lacks the capability to access local files or run commands.

Maccha is an HTTP proxy intended to be run on macOS locally, providing:

* read access to all local files
* write access to files under `~/maccha`
* any execution of local commands, with the above access privileges

It uses sandbox_exec (1) for sandboxes.

The web interface is a dead copy of llama.cpp and its license is subject to that of llama.cpp.

Setup
---

1. Git clone this repository, e.g., to `~/projects`.
2. Run `mkdir ~/maccha`.
3. Run maccha.js, with OPENAI_APY_KEY set (e.g., `OPENAI_API_KEY=... node ~/projects/macca.js`).
4. Open [http://127.0.0.1:11434](http://127.0.0.1:11434).
5. Try asking things like "What time is it in Tokyo?", "ls -l".

Switching between the Models
---

By default, maccha connects to OpenAI API, specifying `gpt-4.1-mini` as the model to be used.

This behavior can be changed by adding `/model:<model-name>` to the end of the chat message.
If the model name starts with `gpt`, then OpenAI is used as the backend, with the model name specifying the actual model.
Otherwise, model name is interpreted as `host:port` specifying where a local LLM server is being run.

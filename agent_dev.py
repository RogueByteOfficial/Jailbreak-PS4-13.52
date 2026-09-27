"""
RogueByte Autonomous Dev Agent
=================================
Autonomous coding agent powered by local Qwen LLM.

Capabilities:
  - Real-time browser error monitoring (HTTP listener port 7788)
  - Read project source files
  - Apply surgical code patches
  - Run build.py after changes to rebuild cache
  - Search across all project files
  - Check JS/HTML bracket syntax

Usage:
  python agent_dev.py

Requirements (stdlib only - no pip needed):
  Python 3.8+  (uses only standard library modules)

Configuration:
  Edit the CONFIG dict below to match your Ollama / LM Studio URL and model name.
"""

import os
import sys
import json
import hashlib
import subprocess
import threading
import textwrap
from pathlib import Path
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.error import URLError

# ===========================================================
#  CONFIGURATION  -- edit to match your setup
# ===========================================================
CONFIG = {
    # Ollama default: "http://localhost:11434"
    # LM Studio default: "http://localhost:1234"
    "llm_base_url": "http://localhost:11434",

    # Model name exactly as shown in `ollama list`
    "llm_model": "qwen2.5-coder:7b",

    # Port this agent listens on for browser error reports
    "agent_port": 7788,

    # Project root (auto-detected as the directory containing this script)
    "project_root": Path(__file__).parent.resolve(),

    # Files the agent is allowed to read and edit (safety whitelist)
    "allowed_files": [
        "index.html", "jb.html", "sender.html",
        "jb.js", "core.js", "mem.js", "rpc_worker.js",
        "int64.js", "ps4_offsets.js",
        "build.py", "cache.appcache",
    ],

    # Maximum ReAct iterations per task before giving up
    "max_fix_iterations": 4,
}

# ===========================================================
#  COLORS  (ANSI, no external deps)
# ===========================================================
class C:
    CYAN   = "\033[96m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    RED    = "\033[91m"
    PURPLE = "\033[95m"
    DIM    = "\033[2m"
    BOLD   = "\033[1m"
    RESET  = "\033[0m"

def _ts():
    return f"{C.DIM}[{datetime.now().strftime('%H:%M:%S')}]{C.RESET}"

def log_info(m):  print(f"{_ts()} {C.CYAN}[INFO]{C.RESET}  {m}")
def log_ok(m):    print(f"{_ts()} {C.GREEN}[OK]{C.RESET}    {m}")
def log_warn(m):  print(f"{_ts()} {C.YELLOW}[WARN]{C.RESET}  {m}")
def log_err(m):   print(f"{_ts()} {C.RED}[ERR]{C.RESET}   {m}")
def log_agent(m): print(f"{_ts()} {C.PURPLE}[AGENT]{C.RESET} {m}")
def log_tool(m):  print(f"{_ts()} {C.YELLOW}[TOOL]{C.RESET}  {m}")

def banner():
    art = """
  ____  ___   ____ _   _ _____   ____  _________
 |  _ \\/ _ \\ / ___| | | | ____| | __ )| __/ ____|
 | |_) | | | | |  _| | | |  _|  |  _ \\|  _|  _|
 |  _ <| |_| | |_| | |_| | |___  | |_) | | | |___
 |_| \\_\\\\___/ \\____|\\___/|_____|  |____/|_| |_____|
    """
    print(f"{C.CYAN}{C.BOLD}{art}{C.RESET}")
    print(f"  {C.PURPLE}Autonomous Dev Agent v1.0  -- Powered by local Qwen LLM{C.RESET}\n")


# ===========================================================
#  PROJECT TOOLS  — functions the agent can invoke
# ===========================================================
class ProjectTools:
    def __init__(self, root: Path, allowed: list):
        self.root = root
        self._allowed = set(allowed)

    # ── safety gate ────────────────────────────────────────
    def _safe(self, rel: str) -> Path:
        clean = rel.strip().lstrip("/\\")
        if clean not in self._allowed:
            raise PermissionError(f"'{clean}' not in allowed list")
        return self.root / clean

    # ── Tool: read_file ────────────────────────────────────
    def read_file(self, filepath: str, start_line: int = 1, end_line: int = None) -> dict:
        """Read a source file (optionally a line range). Always call before patching."""
        log_tool(f"read_file({filepath} lines {start_line}-{end_line})")
        p = self._safe(filepath)
        if not p.exists():
            return {"error": f"not found: {filepath}"}
        raw = p.read_text(encoding="utf-8", errors="replace").splitlines()
        total = len(raw)
        s = max(0, (start_line or 1) - 1)
        e = min(total, end_line or total)
        numbered = "\n".join(f"{s+i+1}: {l}" for i, l in enumerate(raw[s:e]))
        return {"content": numbered, "total_lines": total, "filepath": filepath}

    # ── Tool: apply_patch ──────────────────────────────────
    def apply_patch(self, filepath: str, target_content: str, replacement_content: str) -> dict:
        """Replace an exact unique string in a file. Backs up first."""
        log_tool(f"apply_patch({filepath})")
        p = self._safe(filepath)
        if not p.exists():
            return {"error": f"not found: {filepath}"}
        orig = p.read_text(encoding="utf-8", errors="replace")
        if target_content not in orig:
            return {"error": "target_content not found — check exact whitespace"}
        cnt = orig.count(target_content)
        if cnt > 1:
            return {"error": f"target_content found {cnt} times — be more specific"}
        bak = p.with_suffix(p.suffix + ".bak")
        bak.write_text(orig, encoding="utf-8")
        p.write_text(orig.replace(target_content, replacement_content, 1), encoding="utf-8")
        log_ok(f"Patched {filepath}  (backup: {bak.name})")
        return {"success": True, "backup": bak.name}

    # ── Tool: list_files ───────────────────────────────────
    def list_files(self) -> dict:
        """List all editable project files with size and SHA-256."""
        log_tool("list_files()")
        out = []
        for name in sorted(self._allowed):
            p = self.root / name
            if p.exists():
                st = p.stat()
                out.append({
                    "name": name,
                    "size_kb": round(st.st_size / 1024, 1),
                    "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest()[:12],
                })
        return {"files": out}

    # ── Tool: run_build ────────────────────────────────────
    def run_build(self) -> dict:
        """Run build.py to regenerate cache.appcache. Call after every patch."""
        log_tool("run_build()")
        r = subprocess.run(
            [sys.executable, "build.py"],
            cwd=str(self.root), capture_output=True, text=True, timeout=30
        )
        ok = r.returncode == 0
        if ok:
            log_ok("build.py succeeded")
        else:
            log_err(f"build.py failed: {r.stderr[:400]}")
        return {"success": ok, "stdout": r.stdout[-1500:], "stderr": r.stderr[-500:], "rc": r.returncode}

    # ── Tool: search_in_files ──────────────────────────────
    def search_in_files(self, query: str, file_filter: str = None) -> dict:
        """Search for a string across project files."""
        log_tool(f"search_in_files('{query}' filter={file_filter})")
        hits = []
        targets = [file_filter] if file_filter else list(self._allowed)
        for name in targets:
            p = self.root / name
            if not p.exists():
                continue
            try:
                for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                    if query.lower() in line.lower():
                        hits.append({"file": name, "line": i, "content": line.strip()})
            except Exception:
                pass
        return {"matches": hits[:50], "total": len(hits)}

    # ── Tool: check_js_syntax ─────────────────────────────
    def check_js_syntax(self, filepath: str) -> dict:
        """Check bracket/brace balance in a JS or HTML file."""
        log_tool(f"check_js_syntax({filepath})")
        p = self._safe(filepath)
        content = p.read_text(encoding="utf-8", errors="replace")
        issues, stack = [], []
        pairs = {")": "(", "}": "{", "]": "["}
        for idx, ch in enumerate(content):
            if ch in "({[":
                stack.append((ch, idx))
            elif ch in ")}]":
                if not stack or stack[-1][0] != pairs[ch]:
                    issues.append(f"Unmatched '{ch}' at pos {idx}")
                else:
                    stack.pop()
        for ch, pos in stack:
            issues.append(f"Unclosed '{ch}' at pos {pos}")
        return {"valid": len(issues) == 0, "issues": issues[:10]}

    # ── Tool definitions for LLM ───────────────────────────
    def get_tool_defs(self) -> list:
        return [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a project source file (with optional line range). Use BEFORE making any edit.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "filepath": {"type": "string"},
                            "start_line": {"type": "integer"},
                            "end_line": {"type": "integer"}
                        },
                        "required": ["filepath"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "description": "Replace an exact unique string in a file. target_content MUST be copied verbatim from read_file output.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "filepath": {"type": "string"},
                            "target_content": {"type": "string"},
                            "replacement_content": {"type": "string"}
                        },
                        "required": ["filepath", "target_content", "replacement_content"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List all editable project files with size and hash.",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "run_build",
                    "description": "Run build.py to regenerate cache.appcache. Always call after patching.",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "search_in_files",
                    "description": "Search for a string across project files.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "file_filter": {"type": "string"}
                        },
                        "required": ["query"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "check_js_syntax",
                    "description": "Check bracket/brace balance in a JS or HTML file after patching.",
                    "parameters": {
                        "type": "object",
                        "properties": {"filepath": {"type": "string"}},
                        "required": ["filepath"]
                    }
                }
            },
        ]

    def call(self, name: str, args: dict) -> str:
        fn = getattr(self, name, None)
        if fn is None:
            return json.dumps({"error": f"unknown tool: {name}"})
        try:
            return json.dumps(fn(**args), ensure_ascii=False, indent=2)
        except Exception as exc:
            return json.dumps({"error": str(exc)})


# ===========================================================
#  LLM CLIENT  — talks to Ollama or LM Studio
# ===========================================================
class QwenClient:
    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._ollama = "11434" in base_url

    def _endpoint(self) -> str:
        return f"{self.base_url}/api/chat" if self._ollama else f"{self.base_url}/v1/chat/completions"

    def chat(self, messages: list, tools: list = None) -> dict:
        if self._ollama:
            payload = {"model": self.model, "messages": messages, "stream": False,
                       "options": {"temperature": 0.1, "num_predict": 2048}}
            if tools:
                payload["tools"] = tools
        else:
            payload = {"model": self.model, "messages": messages, "temperature": 0.1,
                       "max_tokens": 2048, "stream": False}
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"

        data = json.dumps(payload).encode()
        req = Request(self._endpoint(), data=data,
                      headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req, timeout=120) as r:
                resp = json.loads(r.read())
        except URLError as e:
            raise ConnectionError(f"LLM unreachable at {self.base_url}: {e}")

        if self._ollama:
            return resp.get("message", {})
        return (resp.get("choices") or [{}])[0].get("message", {})

    def ping(self) -> bool:
        try:
            url = f"{self.base_url}/api/tags" if self._ollama else f"{self.base_url}/v1/models"
            with urlopen(Request(url), timeout=4):
                return True
        except Exception:
            return False


# ===========================================================
#  AGENT LOOP  — Sense → Reason → Act → Verify
# ===========================================================
SYSTEM_PROMPT = (
    "You are RogueByte Dev Agent — an autonomous software engineer for a PS4 browser-based "
    "jailbreak project (JavaScript/HTML files: jb.js, core.js, mem.js, ps4_offsets.js, etc.).\n\n"
    "RULES:\n"
    "1. ALWAYS call read_file before making any change.\n"
    "2. apply_patch target_content must be copied verbatim (exact whitespace) from read_file output.\n"
    "3. After every patch: call check_js_syntax then run_build.\n"
    "4. If a patch breaks things, revert with another apply_patch call.\n"
    "5. Be surgical — edit only what is necessary.\n"
    "6. Think step-by-step; explain before each tool call.\n"
    "7. End with a concise summary of what changed and why."
)


class DevAgent:
    def __init__(self, llm: QwenClient, tools: ProjectTools):
        self.llm = llm
        self.tools = tools
        self._tool_defs = tools.get_tool_defs()
        self._history = [{"role": "system", "content": SYSTEM_PROMPT}]

    def run_task(self, user_msg: str) -> str:
        log_agent(f"Task: {user_msg[:120]}")
        self._history.append({"role": "user", "content": user_msg})

        for iteration in range(CONFIG["max_fix_iterations"]):
            log_info(f"Iteration {iteration+1}/{CONFIG['max_fix_iterations']}")
            msg = self.llm.chat(self._history, tools=self._tool_defs)
            self._history.append(msg)

            calls = msg.get("tool_calls") or []
            if not calls:
                final = msg.get("content", "")
                log_ok("Agent done.")
                return final

            for tc in calls:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except json.JSONDecodeError:
                    args = {}
                log_tool(f"-> {name}({list(args.keys())})")
                result = self.tools.call(name, args)
                self._history.append({
                    "role": "tool",
                    "content": result,
                    "tool_call_id": tc.get("id", name),
                })

        return "Max iterations reached."

    def session(self):
        print(f"\n{C.GREEN}Agent ready. Enter task or error below.{C.RESET}")
        print(f"{C.DIM}  quit   — exit")
        print(f"  reset  — clear conversation history")
        print(f"  files  — list project files{C.RESET}\n")

        while True:
            try:
                user = input(f"{C.CYAN}You >> {C.RESET}").strip()
            except (EOFError, KeyboardInterrupt):
                print(f"\n{C.YELLOW}Goodbye.{C.RESET}")
                break

            if not user:
                continue
            if user.lower() in ("quit", "exit", "q"):
                print(f"{C.YELLOW}Goodbye.{C.RESET}")
                break
            if user.lower() == "reset":
                self._history = [{"role": "system", "content": SYSTEM_PROMPT}]
                log_info("History cleared.")
                continue
            if user.lower() == "files":
                for f in self.tools.list_files()["files"]:
                    print(f"  {C.CYAN}{f['name']:<32}{C.RESET}{f['size_kb']:>7} KB  {C.DIM}{f['sha256']}{C.RESET}")
                continue

            answer = self.run_task(user)
            print(f"\n{C.PURPLE}Agent >>{C.RESET}\n{textwrap.fill(answer, width=100)}\n")


# ===========================================================
#  BROWSER ERROR LISTENER  — receives JS errors from pages
# ===========================================================
class _ErrHandler(BaseHTTPRequestHandler):
    _agent: DevAgent = None  # set at startup

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", errors="replace")
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')
        log_warn(f"Browser error: {body[:200]}")
        if self._agent:
            msg = f"BROWSER ERROR REPORT:\n{body}\n\nAnalyze and fix this in the project code."
            threading.Thread(target=self._agent.run_task, args=(msg,), daemon=True).start()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *_):
        pass  # silence default access log


# ===========================================================
#  ERROR REPORTER  — injected into HTML pages
# ===========================================================
_REPORTER_MARKER = "RogueByte-Agent-Reporter"
_REPORTER_SNIPPET = """\
<!-- {marker} -->
<script>
(function(){{
  const U="http://localhost:{port}/error";
  function send(t,m,s){{
    try{{fetch(U,{{method:"POST",headers:{{"Content-Type":"application/json"}},mode:"no-cors",
      body:JSON.stringify({{type:t,message:m,stack:s,url:location.href,ua:navigator.userAgent}})}})}}catch(e){{}}
  }}
  window.addEventListener("error",function(e){{send("error",e.message,e.filename+":"+e.lineno)}});
  window.addEventListener("unhandledrejection",function(e){{send("promise",String(e.reason),"");}});
}})();
</script>
"""

def _inject_reporter(root: Path, port: int):
    for fname in ("index.html", "jb.html"):
        p = root / fname
        if not p.exists():
            continue
        src = p.read_text(encoding="utf-8")
        if _REPORTER_MARKER in src:
            continue
        snippet = _REPORTER_SNIPPET.format(marker=_REPORTER_MARKER, port=port)
        updated = src.replace("</head>", snippet + "</head>", 1)
        if updated != src:
            p.write_text(updated, encoding="utf-8")
            log_ok(f"Error reporter injected -> {fname}")


# ===========================================================
#  MAIN
# ===========================================================
def main():
    banner()
    root = CONFIG["project_root"]
    log_info(f"Project root : {root}")

    tools = ProjectTools(root, CONFIG["allowed_files"])
    llm   = QwenClient(CONFIG["llm_base_url"], CONFIG["llm_model"])

    log_info(f"LLM endpoint : {CONFIG['llm_base_url']}  model={CONFIG['llm_model']}")
    if llm.ping():
        log_ok("LLM is reachable.")
    else:
        log_warn("LLM not reachable — running in offline mode (tools work, LLM calls will fail).")
        log_warn(f"  Start Ollama: ollama serve && ollama run {CONFIG['llm_model']}")

    agent = DevAgent(llm, tools)

    # inject browser error reporter
    _inject_reporter(root, CONFIG["agent_port"])

    # start background error listener
    _ErrHandler._agent = agent
    srv = HTTPServer(("0.0.0.0", CONFIG["agent_port"]), _ErrHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log_ok(f"Error listener: http://localhost:{CONFIG['agent_port']}/error")

    # show project file list
    print(f"\n{C.BOLD}Editable project files:{C.RESET}")
    for f in tools.list_files()["files"]:
        print(f"  {C.DIM}{f['name']:<34}{f['size_kb']:>6} KB{C.RESET}")

    agent.session()
    srv.shutdown()


if __name__ == "__main__":
    main()

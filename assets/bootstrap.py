import fcntl
import hashlib
import io
import json
import os
import pathlib
import platform
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

COMMIT = "1b6654811346488b696ded8f3c7e6701c57242f1"
SHA256 = "b7ee40e9f8ce199ad9992a7601536cd03f5d25166f63c06e6dc1cf866b773a5a"
BINARY_SHA256 = "99d0de05310b8116f99acde319640ae18b976e2760ecd4e81f3e6f401cc1737a"
URL = "https://blob.superlogical.com/download/rex/preview/" + COMMIT + "/rex-linux-amd64.tar.gz"


def run(rex, *args):
    result = subprocess.run([str(rex), *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr[-1000:])
    return json.loads(result.stdout)


def setup_prompt(home, name):
    startup = [home / f for f in (".bashrc", ".profile", ".bash_profile", ".bash_login")]
    if not any(p.exists() or p.is_symlink() for p in startup):
        with (home / ".bashrc").open("x") as output:
            output.write("# Rex cloud prompt\nif [[ $- == *i* ]]; then\n  PS1='sandbox:" + name + " \\w \\$ '\nfi\n")
        with (home / ".profile").open("x") as output:
            output.write('if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then\n  . "$HOME/.bashrc"\nfi\n')


def main():
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        raise RuntimeError("This prototype requires a Linux amd64 image.")
    root = pathlib.Path.home() / ".local/share/rex-cloud"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    rex = root / "rex"
    with (root / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        setup_prompt(pathlib.Path.home(), sys.argv[1])
        if not rex.is_file() or hashlib.sha256(rex.read_bytes()).hexdigest() != BINARY_SHA256:
            with urllib.request.urlopen(URL, timeout=60) as response:
                archive = response.read(40 * 1024 * 1024 + 1)
            if len(archive) > 40 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != SHA256:
                raise RuntimeError("Rex download checksum did not match the pinned official release.")
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
                member = next((m for m in tar.getmembers() if m.name in ("rex", "./rex") and m.isfile()), None)
                if member is None or member.size > 150 * 1024 * 1024:
                    raise RuntimeError("Unexpected Rex archive contents.")
                data = tar.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != BINARY_SHA256:
                raise RuntimeError("Rex executable checksum did not match the pinned official release.")
            fd, tmp = tempfile.mkstemp(dir=root)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(tmp, 0o700)
                os.replace(tmp, rex)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        version = run(rex, "version", "--json")
        revision = version.get("api_revision")
        if not isinstance(revision, int) or not int(sys.argv[2]) <= revision <= int(sys.argv[3]):
            raise RuntimeError("Rex protocol versions are incompatible. Update rex-cloud and the Rex app/CLI together before reconnecting.")
        server = run(rex, "server", "start", "--json")
        listing = run(rex, "session", "ls", "--json")
        sessions = listing if isinstance(listing, list) else listing["sessions"]
        session = next((s for s in sessions if s.get("label") == sys.argv[1]), None)
        if session:
            sid = session["session_id"]
            detail = run(rex, "session", "inspect", sid, "--json")
            windows = detail.get("windows", [])
            blocks = [b for w in windows for b in w.get("block_ids", [])]
            if not blocks:
                listing = run(rex, "block", "ls", "-s", sid, "--json")
                entries = listing if isinstance(listing, list) else listing.get("blocks", [])
                blocks = [b.get("block_id", b.get("id")) for b in entries]
            if not blocks:
                created = run(rex, "window", "new", "-s", sid, "Terminal", "-c", os.getcwd(), "--json")
                blocks = created["block_ids"]
            bid = blocks[0]
        else:
            created = run(rex, "new", sys.argv[1], "-c", os.getcwd(), "--json")
            sid = created["session_id"]
            bid = created["initial_windows"][0]["block_ids"][0]
        endpoint = server["endpoint"]
        from urllib.parse import unquote
        print(json.dumps({"remoteSocket": unquote(endpoint.removeprefix("unix://")), "cwd": os.getcwd(), "sessionId": sid, "blockId": bid}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

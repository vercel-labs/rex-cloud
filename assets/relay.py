import os
import socket
import sys
import threading
import tty

tty.setraw(0)
remote = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
remote.connect(sys.argv[1])


def write_all(data):
    remaining = memoryview(data)
    while remaining:
        remaining = remaining[os.write(1, remaining):]


write_all(b"REX_CLOUD_RELAY_READY\n")


def feed():
    try:
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            remote.sendall(data)
    except OSError:
        pass
    finally:
        try:
            remote.shutdown(socket.SHUT_WR)
        except OSError:
            pass


threading.Thread(target=feed, daemon=True).start()
try:
    while True:
        data = remote.recv(65536)
        if not data:
            break
        write_all(data)
finally:
    remote.close()

import sys
import os
import threading
from server import AnnanHandler, HTTPServer, ai_player

port = 8080
server = HTTPServer(("", port), AnnanHandler)
print(f"Server started on port {port}")
# Run the server in the background
thread = threading.Thread(target=server.serve_forever)
thread.daemon = True
thread.start()

# Keep main thread alive until killed
import time
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    server.shutdown()

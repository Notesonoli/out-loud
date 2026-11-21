import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); print(self.rfile.read(n).decode(), flush=True)
        self.send_response(200); self.send_header('access-control-allow-origin','*'); self.end_headers()
    def log_message(self,*a): pass
http.server.HTTPServer(("",8773),H).serve_forever()

"""Optional local CPU fur-matting service. Saves comparisons; never approves."""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image
from refine_foreground_matte import refine
from model_adapters import analyze_alpha_bounds, analyze_foreground_regions

ORIGINS={'http://localhost:4173','http://127.0.0.1:4173'}
OUTPUT=Path(__file__).resolve().parents[1]/'generated/matte-refinement-studio'
LOCK=threading.Lock()


def dependencies_ready():
    return all(importlib.util.find_spec(name) is not None for name in ('pymatting','scipy','numba'))

def sha(data):return hashlib.sha256(data).hexdigest()

def decode_png(value, mode):
    if not isinstance(value,str) or len(value)>22_400_000:raise ValueError('invalid-image-size')
    data=base64.b64decode(value,validate=True)
    with Image.open(io.BytesIO(data)) as im:
        if im.format!='PNG' or im.width*im.height>24_000_000 or min(im.size)<32:raise ValueError('invalid-png')
        if mode=='RGBA' and im.mode!='RGBA':raise ValueError('rgba-seed-required')
        return im.convert(mode),data

def handler_type(port):
    class Handler(BaseHTTPRequestHandler):
        def origin_ok(self):
            return self.headers.get('Origin') in ORIGINS and self.headers.get('Host') in {f'localhost:{port}',f'127.0.0.1:{port}'}
        def send_json(self,status,value):
            data=json.dumps(value,ensure_ascii=False).encode('utf-8')
            self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            if self.headers.get('Origin') in ORIGINS:self.send_header('Access-Control-Allow-Origin',self.headers['Origin']);self.send_header('Vary','Origin')
            self.end_headers()
            try:self.wfile.write(data)
            except (ConnectionResetError,ConnectionAbortedError,BrokenPipeError):pass
        def do_OPTIONS(self):
            if not self.origin_ok() or self.path!='/api/refine-matte':self.send_json(403,{'error':'origin-not-allowed'});return
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
            self.send_header('Access-Control-Allow-Methods','POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type');self.end_headers()
        def do_GET(self):
            if not self.origin_ok():self.send_json(403,{'error':'origin-not-allowed'});return
            if self.path!='/api/capabilities':self.send_json(404,{'error':'not-found'});return
            ready=dependencies_ready()
            self.send_json(200,{'ready':ready,'route':'closed-form-matte-v1','requiresHumanReview':True,'installable':False,
                'remoteNetworkUsed':False,'inputPersisted':True,'maxProcessingEdge':1200,
                'unavailableReason':None if ready else 'Local matting dependencies unavailable; no candidate generated'})
        def do_POST(self):
            if not self.origin_ok():self.send_json(403,{'error':'origin-not-allowed'});return
            if self.path!='/api/refine-matte':self.send_json(404,{'error':'not-found'});return
            if not dependencies_ready():self.send_json(503,{'error':'matting-dependencies-unavailable'});return
            if self.headers.get_content_type()!='application/json':self.send_json(415,{'error':'json-required'});return
            try:length=int(self.headers.get('Content-Length','0'))
            except ValueError:length=0
            if not 0<length<=45_000_000:self.send_json(413,{'error':'request-size-out-of-range'});return
            if not LOCK.acquire(False):self.send_json(409,{'error':'matting-busy'});return
            folder=None
            try:
                self.connection.settimeout(20)
                body=self.rfile.read(length)
                if len(body)!=length:raise ValueError('incomplete-request')
                request=json.loads(body)
                if not isinstance(request,dict) or set(request)!={'photoPngBase64','seedPngBase64','inner','outer'}:raise ValueError('invalid-fields')
                inner,outer=request['inner'],request['outer']
                if type(inner) is not int or type(outer) is not int or not 1<=inner<=20 or not 1<=outer<=20:raise ValueError('invalid-trimap-widths')
                photo,photo_data=decode_png(request['photoPngBase64'],'RGB');seed,seed_data=decode_png(request['seedPngBase64'],'RGBA')
                if photo.size!=seed.size:raise ValueError('photo-seed-canvas-mismatch')
                ident=uuid.uuid4().hex;folder=OUTPUT/ident;folder.mkdir(parents=True,exist_ok=False)
                (folder/'photo.png').write_bytes(photo_data);(folder/'seed.png').write_bytes(seed_data)
                original_size=photo.size
                if max(photo.size)>1200:
                    scale=1200/max(photo.size);size=tuple(round(v*scale) for v in photo.size)
                    photo=photo.resize(size,Image.Resampling.LANCZOS);seed=seed.resize(size,Image.Resampling.LANCZOS)
                result,trimap,report=refine(photo,seed,inner,outer)
                result.save(folder/'foreground.png');trimap.save(folder/'trimap.png')
                result_data=(folder/'foreground.png').read_bytes()
                report.update(candidateId=ident,photoSha256=sha(photo_data),seedSha256=sha(seed_data),outputSha256=sha(result_data),
                    inputDimensions=list(original_size),processingDimensions=list(photo.size),resized=photo.size!=original_size,
                    interiorPreservationScope='exact input RGB at processing resolution',remoteNetworkUsed=False,inputPersisted=True,
                    alphaEdgeReview=analyze_alpha_bounds(result),foregroundRegionReview=analyze_foreground_regions(result))
                (folder/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                self.send_json(200,{'status':'candidate-requires-human-review','report':report,'foregroundPngBase64':base64.b64encode(result_data).decode('ascii')})
            except Exception as error:
                if folder:(folder/'failure.json').write_text(json.dumps({'error':type(error).__name__,'detail':str(error),'approved':False}),encoding='utf-8')
                self.send_json(400 if isinstance(error,(ValueError,TypeError,KeyError)) else 503,{'error':'matting-failed','detail':type(error).__name__})
            finally:LOCK.release()
        def log_message(self,*args):pass
    return Handler

def main():
    global OUTPUT
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=4181);p.add_argument('--output',type=Path,default=OUTPUT);a=p.parse_args()
    if not 1024<=a.port<=65535:p.error('Invalid port')
    # Fail before advertising readiness if optional dependencies cannot import.
    from pymatting import estimate_alpha_cf,estimate_foreground_ml
    OUTPUT=a.output.resolve()
    server=ThreadingHTTPServer(('127.0.0.1',a.port),handler_type(a.port));print(f'Matte comparison ready on {a.port}',flush=True)
    try:server.serve_forever()
    finally:server.server_close()

if __name__=='__main__':main()

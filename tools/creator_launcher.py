"""Self-contained local creator host; all generated material remains review-only."""
from __future__ import annotations

import argparse
import ctypes
import json
import mimetypes
import msvcrt
import os
import re
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import webbrowser
import urllib.request

sys.dont_write_bytecode=True
import head_tilt_service as tilt
import creative_plan_service as planner
import matte_refinement_service as matting
import eye_motion_backend as animal
import creator_segmentation_backend as segmentation
import face_landmark_backend as faces

PRODUCT='little-orbit.creator'
FILES={'/':'index.html','/index.html':'index.html','/app.js':'app.js',
       '/simple-ui.js':'simple-ui.js','/simple-ui.css':'simple-ui.css',
       '/styles.css':'styles.css','/reference-cat.jpg':'reference-cat.jpg',
       '/assets/reviewed-reference-cat.png':'assets/reviewed-reference-cat.png',
       '/assets/pending-model-reference-cat.png':'assets/pending-model-reference-cat.png',
       '/creator-control.js':'creator-control.js','/theme-frame-player.js':'theme-frame-player.js'}


class ExclusiveServer(ThreadingHTTPServer):
    allow_reuse_address=False
    def server_bind(self):
        if os.name=='nt':self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        super().server_bind()


def reopen_running(data, headless):
    """A lock alone is not liveness evidence; verify the owner's local server."""
    deadline=time.monotonic()+12
    while time.monotonic()<deadline:
        try:
            status=json.loads((data/'creator-status.json').read_text(encoding='utf-8'))
            port=status['ports'][0]
            if status['status']!='ready' or type(port) is not int or not 1024<=port<=65535:
                raise ValueError('Owner is not ready')
            # Never honor a hostname or URL from the saved record.
            url=f'http://127.0.0.1:{port}'
            with urllib.request.urlopen(url+'/api/creator',timeout=1) as response:
                live=json.load(response)
            if (live.get('product')!=PRODUCT or live.get('status')!='ready' or
                not status.get('instanceId') or live.get('instanceId')!=status['instanceId'] or
                live.get('pid')!=status['pid']):
                raise ValueError('Owner identity mismatch')
            if not headless:webbrowser.open(url+'/')
            return True
        except (OSError,ValueError,KeyError,TypeError):time.sleep(.2)
    return False


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--web-port',type=int)
    parser.add_argument('--tilt-port',type=int)
    parser.add_argument('--plan-port',type=int)
    parser.add_argument('--matte-port',type=int)
    parser.add_argument('--data-dir',type=Path)
    parser.add_argument('--headless',action='store_true')
    parser.add_argument('--duration-seconds',type=int,default=0)
    args=parser.parse_args()
    port_keys=('web_port','tilt_port','plan_port','matte_port')
    explicit_ports={key:getattr(args,key) is not None for key in port_keys}
    for key,default in (('web_port',4173),('tilt_port',4180),('plan_port',4178),('matte_port',4181)):
        if getattr(args,key) is None:setattr(args,key,default)
    ports=tuple(getattr(args,key) for key in port_keys)
    if len(set(ports))!=4 or any(not 1024<=p<=65535 for p in ports):parser.error('Four distinct user ports are required')
    if not 0<=args.duration_seconds<=3600:parser.error('Invalid bounded diagnostic duration')
    resources=Path(sys._MEIPASS) if getattr(sys,'frozen',False) else Path(__file__).resolve().parents[1]
    webroot=resources/'studio' if getattr(sys,'frozen',False) else resources
    controls=resources/'studio/creator-control.js' if getattr(sys,'frozen',False) else resources/'tools/creator-control.js'
    data=args.data_dir or Path(os.environ['LOCALAPPDATA'])/'AI Pet Studio/creator'
    if not data.is_absolute():parser.error('Data directory must be absolute')
    data.mkdir(parents=True,exist_ok=True)
    # Windows releases this byte-range lock even if the process crashes. The
    # file remains; its existence is never treated as evidence of a live owner.
    ownership=(data/'creator-owner.lock').open('a+b')
    if ownership.seek(0,2)==0:ownership.write(b'0');ownership.flush()
    ownership.seek(0)
    try:msvcrt.locking(ownership.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:
        ownership.close()
        if reopen_running(data,args.headless):return
        if not args.headless:
            ctypes.windll.user32.MessageBoxW(None,'工坊正在启动或关闭，暂时无法重新打开。请稍后重试；已有作品未变更。','AI Pet 创作工坊',0x10)
        raise SystemExit(2)
    status_file=data/'creator-status.json'
    try:
        previous=json.loads(status_file.read_text(encoding='utf-8'))
        saved_ports=previous['ports']
        if (previous['product']==PRODUCT and len(saved_ports) in (3,4) and
            len(set(saved_ports))==len(saved_ports) and all(type(p) is int and 1024<=p<=65535 for p in saved_ports)):
            requested=[getattr(args,k) for k in explicit_ports if explicit_ports[k]]
            for key,port in zip(port_keys,saved_ports):
                if not explicit_ports[key] and port not in requested:setattr(args,key,port)
    except (OSError,ValueError,KeyError,TypeError):pass
    def write_status(value):
        temporary=data/f'creator-status.{os.getpid()}.tmp'
        temporary.write_text(json.dumps(value),encoding='utf-8')
        # Windows readers may briefly hold the status file without delete sharing.
        # Preserve atomic publication and bound retries rather than abort startup.
        for attempt in range(10):
            try:os.replace(temporary,status_file);break
            except PermissionError:
                if attempt==9:raise
                time.sleep(.05)
    write_status({'product':PRODUCT,'status':'starting','pid':os.getpid()})
    if sys.stderr is None:sys.stderr=(data/'creator-service.log').open('a',encoding='utf-8',buffering=1)
    if sys.stdout is None:sys.stdout=sys.stderr
    ffmpeg=resources/'bin'
    if ffmpeg.is_dir():os.environ['PATH']=str(ffmpeg)+os.pathsep+os.environ.get('PATH','')
    # The frozen runtime writes only to user data, never the installation folder.
    tilt.ROOT=data
    animal.CONFIG_PATH=data/'animal-backend.json'
    faces.CONFIG_PATH=data/'face-backend.json'
    faces.OUTPUT=data/'generated/face-point-drafts'
    tilt.OUTPUT=data/'generated/transparent-head-tilt-studio'
    planner.OUTPUT=data/'generated/creative-plan-studio'
    matting.OUTPUT=data/'generated/matte-refinement-studio'
    segmentation.OUTPUT=data/'generated/creator-segmentation'
    # Numba's cached machine code is runtime data, never an installation write.
    os.environ['NUMBA_CACHE_DIR']=str(data/'cache/numba')
    planner.SCHEMA=resources/'tools/creative_plan.schema.json'
    planner.HEAD_TILT_SCHEMA=resources/'tools/head_tilt_plan.schema.json'
    origins={f'http://localhost:{args.web_port}',f'http://127.0.0.1:{args.web_port}'}
    tilt.ORIGINS=origins
    planner.ORIGINS=origins
    matting.ORIGINS=origins
    planner.PORT=args.plan_port
    stop=threading.Event()
    token=secrets.token_urlsafe(32)
    instance_id=secrets.token_hex(24)

    class StaticHandler(BaseHTTPRequestHandler):
        def valid_host(self):return self.headers.get('Host') in {f'localhost:{args.web_port}',f'127.0.0.1:{args.web_port}'}
        def send(self,status,body,content_type='application/json'):
            self.send_response(status);self.send_header('Content-Type',content_type)
            self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','strict-origin-when-cross-origin')
            self.end_headers()
            try:self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
        def do_GET(self):
            if not self.valid_host():self.send(403,b'{}');return
            path=urlsplit(self.path).path
            if path=='/api/segmentation/capabilities':
                if (self.headers.get('Origin') not in origins and
                    not any(self.headers.get('Referer','').startswith(origin+'/') for origin in origins)):
                    self.send(403,b'{}');return
                match=re.fullmatch(r'/api/segmentation/capabilities\?adapter=(birefnet-local|sam2-local)',self.path)
                if not match:self.send(400,b'{}');return
                self.send(*segmentation.run('capabilities',match[1]));return
            if path=='/api/creator':
                self.send(200,json.dumps({'product':PRODUCT,'status':'stopping' if stop.is_set() else 'ready','shutdownToken':token,
                    'pid':os.getpid(),'instanceId':instance_id,
                    'frozen':bool(getattr(sys,'frozen',False)),'offlineRoutes':['head-tilt']+(['fur-matting'] if matting.dependencies_ready() else []),
                    'optionalTextPlanner':'Codex CLI','gpuModelsBundled':False}).encode());return
            if path not in FILES:self.send(404,b'{}');return
            source=controls if path=='/creator-control.js' else webroot/FILES[path]
            body=source.read_bytes()
            if source.suffix in ('.js','.html'):
                text=body.decode('utf-8-sig')
                text=text.replace('http://127.0.0.1:4174/api/','/api/segmentation/')
                port_map={'4173':args.web_port,'4180':args.tilt_port,'4178':args.plan_port,'4181':args.matte_port}
                text=re.sub(r'http://(localhost|127\.0\.0\.1):(4173|4180|4178|4181)(?!\d)',
                            lambda m:f'http://{m[1]}:{port_map[m[2]]}',text)
                if source.name=='index.html':text=text.replace('</body>','<script src="./creator-control.js"></script></body>')
                body=text.encode('utf-8')
            kind=mimetypes.guess_type(source.name)[0] or 'application/octet-stream'
            if source.suffix in ('.js','.html','.css'):kind+='; charset=utf-8'
            self.send(200,body,kind)
        def do_POST(self):
            if self.path.startswith('/api/segmentation/'):
                if not self.valid_host() or self.headers.get('Origin') not in origins:
                    self.send(403,b'{}');return
                match=re.fullmatch(r'/api/segmentation/(segment|package-still)\?adapter=(birefnet-local|sam2-local)',self.path)
                if not match:self.send(404,b'{}');return
                try:length=int(self.headers.get('Content-Length','-1'))
                except ValueError:length=-1
                if not 0<length<=16*1024*1024:self.send(413,b'{}');return
                content_type=self.headers.get_content_type()
                if content_type not in ('image/png','image/jpeg','image/webp','application/octet-stream'):
                    self.send(415,b'{}');return
                body=self.rfile.read(length)
                if len(body)!=length:self.send(400,b'{}');return
                self.send(*segmentation.run(match[1],match[2],body,content_type,self.headers.get('X-Segment-Prompts')));return
            if not self.valid_host() or self.headers.get('Origin') not in origins or self.headers.get('X-Creator-Token')!=token:
                self.send(403,b'{}');return
            if self.path!='/api/creator/stop':self.send(404,b'{}');return
            self.send(200,b'{"stopping":true}');stop.set()
        def log_message(self,*args):pass

    servers=[];server_threads=[]
    try:
        # Bind everything before starting any worker; port conflicts leave no
        # partially running creator and never kill an unrelated local process.
        for key in port_keys:
            port=getattr(args,key)
            try:server=ExclusiveServer(('127.0.0.1',port),BaseHTTPRequestHandler)
            except OSError:
                if explicit_ports[key]:raise
                server=ExclusiveServer(('127.0.0.1',0),BaseHTTPRequestHandler)
            setattr(args,key,server.server_port)
            server.daemon_threads=True
            servers.append(server)
        ports=tuple(getattr(args,key) for key in port_keys)
        origins.clear();origins.update({f'http://localhost:{args.web_port}',f'http://127.0.0.1:{args.web_port}'})
        planner.PORT=args.plan_port
        for server,handler in zip(servers,(StaticHandler,tilt.handler_type(args.tilt_port),planner.Handler,matting.handler_type(args.matte_port))):
            server.RequestHandlerClass=handler
        for server in servers:
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start();server_threads.append((server,thread))
        status={'product':PRODUCT,'status':'ready','pid':os.getpid(),'instanceId':instance_id,'ports':list(ports),'frozen':bool(getattr(sys,'frozen',False))}
        write_status(status)
        if not args.headless:webbrowser.open(f'http://localhost:{args.web_port}/')
        stop.wait(args.duration_seconds or None)
        # Do not abandon an in-flight local render or text planner on Stop.
        with tilt.LOCK:
            with planner.PLAN_LOCK:
                with matting.LOCK:
                    with segmentation.LOCK:
                        for server in servers:server.shutdown()
        write_status(dict(status,status='stopped'))
    except Exception as error:
        write_status({'product':PRODUCT,'status':'error','error':str(error)[:300]})
        if not args.headless:
            ctypes.windll.user32.MessageBoxW(None,'创作程序未能启动。端口可能已被其他服务占用；请关闭自己的旧工坊后重试。\n'+str(error)[:200],'AI Pet 创作工坊',0x10)
        # Avoid a second PyInstaller exception dialog, including in diagnostics.
        raise SystemExit(1)
    finally:
        # Join serving loops even when publishing ready fails. Closing live
        # sockets otherwise races daemon stderr writes during interpreter exit.
        for server,thread in server_threads:
            server.shutdown();thread.join(timeout=5)
        for server in servers:server.server_close()
        ownership.seek(0);msvcrt.locking(ownership.fileno(),msvcrt.LK_UNLCK,1);ownership.close()


if __name__=='__main__':main()

"""Loopback-only CPU head-tilt candidate bridge. Never approves or installs."""
from __future__ import annotations
import argparse
import base64
import io
import hashlib
import json
import re
import shutil
import subprocess
import threading
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from PIL import Image
from transparent_head_tilt import generate, validate_plan, sha
from theme_package import pack_multi, _validate_manifest
from review_ledger import ledger_path, decision_for, set_decision, REASONS
from eye_motion_backend import capabilities as eye_capabilities, create_bundle, configure_backend
from model_head_backend import capabilities as head_capabilities,create_template,validate_request_plan
from review_video import encode_review_assets
from model_bundle_backend import capabilities as bundle_capabilities,create_model_bundle,redo_model_head,validate_head_redo
import face_landmark_backend as face_backend

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/'generated/transparent-head-tilt-studio'
ORIGINS={'http://localhost:4173','http://127.0.0.1:4173'}
LOCK=threading.Lock()
FILES={'hover-190px.mp4':'video/mp4','idle-190px.mp4':'video/mp4','click-190px.mp4':'video/mp4','phases.png':'image/png','report.json':'application/json','candidate.lotheme':'application/zip'}


def action_summary(report):
    if report.get('motionKind') not in ('eye-bundle','model-head','model-bundle'):return None
    return [{'slot':slot,'frameCount':len(action['frames']),'fps':action['fps']}
        for slot,action in report['actions'].items()]


def candidate_record(ident):
    folder=OUTPUT/ident
    if (folder/'failure.json').is_file():raise ValueError('candidate-generation-failed')
    report=json.loads((folder/'motion/report.json').read_text(encoding='utf-8'))
    request=json.loads((folder/'request.json').read_text(encoding='utf-8'))
    package=folder/'motion/candidate.lotheme'
    if report.get('candidateId')!=ident or sha(package)!=report.get('packageSha256'):
        raise ValueError('candidate-fingerprint-mismatch')
    decision=decision_for(ledger_path(),package)
    return {'candidateId':ident,'photoSha256':report['photoSha256'],'sourceSha256':report['sourceSha256'],
            'packageSha256':report['packageSha256'],'frameCount':len(report['frames']),
            'plan':request['plan'],'aiPlan':request.get('aiPlan'),'singleActionRedo':report.get('singleActionRedo'),
            'motionKind':report.get('motionKind','head-tilt'),'actions':action_summary(report),
            'approved':False,'installable':False,'reviewIssue':decision['reason'] if decision else None}


def verify_ai_plan(trace, plan):
    """Verify persisted model output, exact Prompt and executed parameters."""
    if trace is None:return None
    if not isinstance(trace,dict) or set(trace)!={'id','promptSha256'} or not isinstance(trace['id'],str) or not re.fullmatch('[a-f0-9]{32}',trace['id']):
        raise ValueError('Invalid AI plan trace')
    from creative_plan_service import validate_plan as validate_creative_plan
    record_path=ROOT/'generated/creative-plan-studio'/(trace['id']+'.json')
    if not record_path.is_file():raise ValueError('AI plan record not found')
    record=json.loads(record_path.read_text(encoding='utf-8'))
    digest=hashlib.sha256(plan['prompt'].encode('utf-8')).hexdigest()
    if record.get('id')!=trace['id'] or record.get('promptSha256')!=digest or trace['promptSha256']!=digest or record.get('model')!='gpt-6-luna' or record.get('adapter')!='Codex CLI' or record.get('photoSent') is not False or record.get('installable') is not False or record.get('status')!='plan-requires-human-review' or record.get('route')!='local-head-tilt-review':
        raise ValueError('AI plan provenance or route mismatch')
    execution=validate_creative_plan(record['plan'],'head-tilt')['headTiltExecution']
    if not execution['supported'] or any(execution[key]!=plan[key] for key in ('degrees','durationSeconds','direction')):
        raise ValueError('AI plan parameters do not match executed motion')
    return {'id':trace['id'],'promptSha256':digest,'recordSha256':sha(record_path),'model':record['model'],'execution':execution,'photoSent':False}


def handler_type(port):
    class Handler(BaseHTTPRequestHandler):
        def origin_ok(self):
            return self.headers.get('Origin') in ORIGINS and self.headers.get('Host') in {f'localhost:{port}',f'127.0.0.1:{port}'}

        def send(self,status,body,kind='application/json',extra=None):
            self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            for key,value in (extra or {}).items():self.send_header(key,value)
            if self.headers.get('Origin') in ORIGINS:self.send_header('Access-Control-Allow-Origin',self.headers['Origin']);self.send_header('Vary','Origin')
            try:self.end_headers();self.wfile.write(body)
            except (BrokenPipeError,ConnectionAbortedError,ConnectionResetError):pass

        def data(self,status,value):self.send(status,json.dumps(value,ensure_ascii=False).encode('utf-8'))

        def do_OPTIONS(self):
            if not self.origin_ok() or self.path not in ('/api/head-tilt','/api/eye-motion','/api/model-head','/api/model-bundle','/api/model-bundle/redo-head','/api/review','/api/animal-backend','/api/face-backend','/api/face-points'):self.data(403,{'error':'origin-not-allowed'});return
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers['Origin']);self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type');self.end_headers()

        def do_GET(self):
            # Media/download elements omit Origin; restrict these GETs by exact
            # Host and a same-studio Referer. No filesystem paths are accepted.
            media_ok=self.headers.get('Host') in {f'localhost:{port}',f'127.0.0.1:{port}'} and any(self.headers.get('Referer','').startswith(o+'/') for o in ORIGINS)
            if not self.origin_ok() and not media_ok:self.data(403,{'error':'origin-not-allowed'});return
            if self.path=='/api/capabilities':self.data(200,{'ready':shutil.which('ffmpeg') is not None,'route':'transparent-head-tilt-v1','remoteNetworkUsed':False,'requiresHumanReview':True,'promptProseExecuted':False,'maxSourceEdge':768,'eyeMotion':eye_capabilities(),'modelHead':head_capabilities(),'modelBundle':bundle_capabilities(),'facePoints':face_backend.capabilities()});return
            playback=re.fullmatch(r'/candidate/([a-f0-9]{32})/playback.json\?sha256=([a-f0-9]{64})',self.path)
            if playback:
                try:
                    record=candidate_record(playback[1])
                    if record['packageSha256']!=playback[2]:raise ValueError('candidate-fingerprint-mismatch')
                    with zipfile.ZipFile(OUTPUT/playback[1]/'motion/candidate.lotheme') as archive:
                        info=archive.getinfo('manifest.json')
                        if info.file_size>65536:raise ValueError('invalid-frame-manifest')
                        actions=_validate_manifest(json.loads(archive.read(info)))
                    self.data(200,{'packageSha256':record['packageSha256'],'approved':False,
                        'actions':[{'slot':a['slot'],'fps':a['fps'],'loop':a['loop'],'frameCount':len(a['frames'])} for a in actions]});return
                except (OSError,ValueError,KeyError,TypeError,zipfile.BadZipFile):
                    self.data(409,{'error':'candidate-playback-unavailable'});return
            frame=re.fullmatch(r'/candidate/([a-f0-9]{32})/frame/(idle|hover|click)/(0|[1-9][0-9]{0,2})\.png\?sha256=([a-f0-9]{64})',self.path)
            if frame:
                try:
                    record=candidate_record(frame[1])
                    if record['packageSha256']!=frame[4]:raise ValueError('candidate-fingerprint-mismatch')
                    # Read canonical indexed entries from the bound package,
                    # never a user-supplied filename or mutable sidecar frame.
                    with zipfile.ZipFile(OUTPUT/frame[1]/'motion/candidate.lotheme') as archive:
                        info=archive.getinfo('manifest.json')
                        if info.file_size>65536:raise ValueError('invalid-frame-manifest')
                        manifest=json.loads(archive.read(info))
                        action=next((a for a in _validate_manifest(manifest) if a['slot']==frame[2]),None)
                        index=int(frame[3])
                        if action is None or index>=len(action['frames']):
                            self.data(404,{'error':'frame-not-found'});return
                        name=f'frames/{frame[2]}/{index+1:04d}.png'
                        if action['frames'][index]!=name:raise ValueError('invalid-frame-entry')
                        info=archive.getinfo(name)
                        if info.file_size>4*1024*1024:raise ValueError('frame-too-large')
                        payload=archive.read(info)
                    with Image.open(io.BytesIO(payload)) as image:
                        if image.format!='PNG' or image.mode!='RGBA' or max(image.size)>768:raise ValueError('invalid-frame-image')
                    self.send(200,payload,'image/png',{'X-Frame-Sha256':hashlib.sha256(payload).hexdigest(),
                        'Access-Control-Expose-Headers':'X-Frame-Sha256'});return
                except (OSError,ValueError,KeyError,TypeError,zipfile.BadZipFile):
                    self.data(409,{'error':'candidate-frame-unavailable'});return
            history=re.fullmatch(r'/api/candidates/([a-f0-9]{64})',self.path)
            if history:
                if not self.origin_ok():self.data(403,{'error':'origin-required'});return
                records=[];unavailable=0
                for folder in sorted(OUTPUT.glob('*'),key=lambda p:p.stat().st_mtime,reverse=True):
                    if not re.fullmatch('[a-f0-9]{32}',folder.name):continue
                    try:
                        request=json.loads((folder/'request.json').read_text(encoding='utf-8'))
                        if request.get('photoSha256')!=history[1]:continue
                        record=candidate_record(folder.name)
                        record['assets']={name:f'http://127.0.0.1:{port}/candidate/{folder.name}/'+name for name in FILES}
                        records.append(record)
                        if len(records)>=24:break
                    except (OSError,ValueError,KeyError):unavailable+=1
                self.data(200,{'candidates':records,'unavailable':unavailable,'approved':False});return
            match=re.fullmatch(r'/candidate/([a-f0-9]{32})/([a-zA-Z0-9.-]+)',self.path)
            if not match or match[2] not in FILES:self.data(404,{'error':'not-found'});return
            path=OUTPUT/match[1]/'motion'/match[2]
            if not path.is_file():self.data(404,{'error':'not-found'});return
            if match[2]=='candidate.lotheme':
                try:
                    record=candidate_record(match[1])
                    if record['reviewIssue']:self.data(409,{'error':'candidate-needs-work','reason':record['reviewIssue']});return
                except (OSError,ValueError,KeyError):self.data(409,{'error':'candidate-review-unavailable'});return
            payload=path.read_bytes();headers={}
            if match[2].endswith('.mp4'):
                headers['Accept-Ranges']='bytes'
                requested=self.headers.get('Range')
                if requested:
                    span=re.fullmatch(r'bytes=(\d*)-(\d*)',requested)
                    if not span or not (span[1] or span[2]):
                        self.send(416,b'',extra={'Content-Range':f'bytes */{len(payload)}'});return
                    start=int(span[1]) if span[1] else max(0,len(payload)-int(span[2]))
                    end=min(int(span[2]),len(payload)-1) if span[1] and span[2] else len(payload)-1
                    if start>end or start>=len(payload):
                        self.send(416,b'',extra={'Content-Range':f'bytes */{len(payload)}'});return
                    headers['Content-Range']=f'bytes {start}-{end}/{len(payload)}'
                    self.send(206,payload[start:end+1],FILES[match[2]],headers);return
            self.send(200,payload,FILES[match[2]],headers)

        def do_POST(self):
            if not self.origin_ok():self.data(403,{'error':'origin-not-allowed'});return
            if self.path not in ('/api/head-tilt','/api/eye-motion','/api/model-head','/api/model-bundle','/api/model-bundle/redo-head','/api/review','/api/animal-backend','/api/face-backend','/api/face-points'):self.data(404,{'error':'not-found'});return
            if self.headers.get_content_type()!='application/json':self.data(415,{'error':'json-required'});return
            try:length=int(self.headers.get('Content-Length','-1'))
            except ValueError:length=-1
            if not 0<length<=12*1024*1024:self.data(413,{'error':'request-too-large'});return
            if not LOCK.acquire(False):self.data(409,{'error':'generation-busy'});return
            folder=None
            try:
                request=json.loads(self.rfile.read(length))
                if self.path=='/api/animal-backend':
                    self.data(200, configure_backend(request));return
                if self.path=='/api/face-backend':
                    self.data(200,face_backend.configure(request));return
                if self.path=='/api/face-points':
                    self.data(200,face_backend.propose(request));return
                if self.path=='/api/review':
                    if not isinstance(request,dict) or set(request)!={'candidateId','packageSha256','reason'} or not isinstance(request['candidateId'],str) or not re.fullmatch('[a-f0-9]{32}',request['candidateId']) or not isinstance(request['reason'],str) or request['reason'] not in REASONS:
                        raise ValueError('invalid-review-decision')
                    record=candidate_record(request['candidateId'])
                    if record['packageSha256']!=request['packageSha256']:raise ValueError('candidate-fingerprint-mismatch')
                    # Rejection is sticky here. Repeated clicks preserve the first reason;
                    # this endpoint cannot approve or clear a desktop installation veto.
                    if not record['reviewIssue']:
                        set_decision(ledger_path(),OUTPUT/request['candidateId']/'motion/candidate.lotheme',request['candidateId'],request['reason'])
                    self.data(200,dict(candidate_record(request['candidateId']),status='needs-work'));return
                eye_motion=self.path=='/api/eye-motion'
                redo=self.path=='/api/model-bundle/redo-head'
                model_bundle=self.path=='/api/model-bundle' or redo
                model_head=self.path=='/api/model-head' or model_bundle
                fields=({'parentCandidateId','parentPackageSha256','photoSha256','plan'} if redo else {'imageBase64','photoSha256','plan'}) | ({'eyeMotion'} if eye_motion else set())
                if not isinstance(request,dict) or set(request) not in (fields,fields|{'aiPlan'}):raise ValueError('Invalid request fields')
                if not isinstance(request['photoSha256'],str) or not re.fullmatch('[a-f0-9]{64}',request['photoSha256']):raise ValueError('Invalid source photo fingerprint')
                if model_head and request.get('aiPlan') is not None:raise ValueError('2D AI plan cannot execute the fixed model head template')
                plan=validate_request_plan(request['plan']) if model_head else validate_plan(request['plan'])
                ai_plan=None if model_head else verify_ai_plan(request.get('aiPlan'),plan)
                parent=None
                if redo:
                    if not isinstance(request['parentCandidateId'],str) or not re.fullmatch('[a-f0-9]{32}',request['parentCandidateId']):raise ValueError('Invalid redo parent identifier')
                    record=candidate_record(request['parentCandidateId'])
                    if record['packageSha256']!=request['parentPackageSha256'] or record['photoSha256']!=request['photoSha256']:raise ValueError('Head redo parent fingerprint mismatch')
                    if record['reviewIssue'] not in (None,'motion'):raise ValueError('Identity, anatomy, crop or edge rejection requires source repair; head-only redo blocked')
                    parent=OUTPUT/request['parentCandidateId'];validate_head_redo(parent,plan)
                    raw=(parent/'source.png').read_bytes()
                else:raw=base64.b64decode(request['imageBase64'],validate=True)
                with Image.open(io.BytesIO(raw)) as im:
                    if im.format!='PNG' or im.mode!='RGBA' or max(im.size)>768:raise ValueError('Expected RGBA PNG up to 768px')
                ident=uuid.uuid4().hex;folder=OUTPUT/ident;folder.mkdir(parents=True)
                source=folder/'source.png';source.write_bytes(raw)
                (folder/'request.json').write_text(json.dumps({'photoSha256':request['photoSha256'],'plan':plan,'aiPlan':ai_plan,
                    **({'eyeMotion':request['eyeMotion']} if eye_motion else {}),
                    **({'redoFrom':{'candidateId':request['parentCandidateId'],'packageSha256':request['parentPackageSha256']}} if redo else {})},ensure_ascii=False,indent=2),encoding='utf-8')
                if model_bundle:
                    report=redo_model_head(parent,plan,folder,request['photoSha256']) if redo else create_model_bundle(source,plan,folder,request['photoSha256'])
                elif model_head:
                    report=create_template(source,plan,folder)
                elif eye_motion:
                    report=create_bundle(source,plan,folder,request['eyeMotion'])
                else:
                    report=generate(source,plan,folder/'motion')
                    review_video=folder/'motion/hover-190px.mp4'
                    raw_video=folder/'motion/hover-review-source.mp4'
                    review_video.rename(raw_video)
                    encoder=shutil.which('ffmpeg')
                    if not encoder:raise ValueError('FFmpeg is required for browser-compatible review video')
                    report['reviewEncoding']=encode_review_assets(folder/'motion',{
                        'idle':{'fps':1,'frames':[{'file':'frame-000.png','sha256':sha(folder/'motion/idle/frame-000.png')}]},
                        'hover':{'fps':report['fps'],'frames':report['frames']}},encoder)
                if not model_bundle:pack_multi(SimpleNamespace(spec=folder/'motion/spec.json',output=folder/'motion/candidate.lotheme'))
                report.update({'candidateId':ident,'photoSha256':request['photoSha256'],'packageSha256':sha(folder/'motion/candidate.lotheme'),'aiPlan':ai_plan})
                (folder/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                disposition=decision_for(ledger_path(),folder/'motion/candidate.lotheme')
                self.data(200,{'candidateId':ident,'status':'candidate-requires-human-review','approved':False,'installable':False,'frameCount':len(report['frames']),
                               'reviewIssue':disposition['reason'] if disposition else None,
                               'motionKind':report.get('motionKind','head-tilt'),'actions':action_summary(report),
                               'singleActionRedo':report.get('singleActionRedo'),
                               'photoSha256':request['photoSha256'],'sourceSha256':report['sourceSha256'],'packageSha256':report['packageSha256'],
                               'assets':{name:f'http://127.0.0.1:{port}/candidate/{ident}/'+name for name in FILES}})
            except Exception as error:
                if folder:(folder/'failure.json').write_text(json.dumps({'error':str(error),'approved':False}),encoding='utf-8')
                self.data(400,{'error':str(error)[:240]})
            finally:LOCK.release()

    return Handler


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=4180);args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler_type(args.port));server.serve_forever()

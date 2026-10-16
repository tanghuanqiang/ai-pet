"""Bounded, isolated VACE region-control experiment. Never approves or installs a pet.

Requires already downloaded, SHA-256 verified VACE files and an existing ComfyUI.
Case JSON supplies an anchor, explicit ROI, prompt and seed; no automatic anatomy
inference is claimed. All outputs and failed attempts remain review candidates.
"""
from __future__ import annotations
import argparse, hashlib, json, os, socket, subprocess, time, uuid
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
from generate_pet_comfy import request_json, result_paths, atomic_json

MODELS = {
 'wan2.1_vace_1.3B_fp16.safetensors':'640ccc0577e6a5d4bb15cd91b11b699ef914fc55f126c5a1c544e152130784f2',
 'wan_2.1_vae.safetensors':'2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b',
}

def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for block in iter(lambda:f.read(8*1024*1024),b''):h.update(block)
 return h.hexdigest()

def graph(case, anchor_name, mask_name, control_name):
 length=33
 return {
 '1':{'class_type':'UNETLoader','inputs':{'unet_name':'wan2.1_vace_1.3B_fp16.safetensors','weight_dtype':'default'}},
 '2':{'class_type':'CLIPLoader','inputs':{'clip_name':'umt5_xxl_fp8_e4m3fn_scaled.safetensors','type':'wan','device':'cpu'}},
 '3':{'class_type':'VAELoader','inputs':{'vae_name':'wan_2.1_vae.safetensors'}},
 '4':{'class_type':'CLIPTextEncode','inputs':{'clip':['2',0],'text':case['prompt']}},
 '5':{'class_type':'CLIPTextEncode','inputs':{'clip':['2',0],'text':'extra animal, extra limb, extra tail, changed face, changed coat, camera motion, text, blur, distorted anatomy, walking, body movement'}},
 '6':{'class_type':'LoadImage','inputs':{'image':anchor_name}},
 '7':{'class_type':'LoadImage','inputs':{'image':mask_name}},
 '8':{'class_type':'RepeatImageBatch','inputs':{'image':['17',0],'amount':length}},
 '9':{'class_type':'RepeatImageBatch','inputs':{'image':['7',0],'amount':length}},
 '10':{'class_type':'ImageToMask','inputs':{'image':['9',0],'channel':'red'}},
 '11':{'class_type':'WanVaceToVideo','inputs':{'positive':['4',0],'negative':['5',0],'vae':['3',0],
       'width':512,'height':512,'length':length,'batch_size':1,'strength':1.0,
       'control_video':['8',0],'control_masks':['10',0],'reference_image':['6',0]}},
 '12':{'class_type':'KSampler','inputs':{'model':['16',0],'positive':['11',0],'negative':['11',1],
       'latent_image':['11',2],'seed':case['seed'],'steps':20,'cfg':6.0,'sampler_name':'uni_pc','scheduler':'simple','denoise':1.0}},
 '13':{'class_type':'TrimVideoLatent','inputs':{'samples':['12',0],'trim_amount':['11',3]}},
 '14':{'class_type':'VAEDecode','inputs':{'samples':['13',0],'vae':['3',0]}},
 '15':{'class_type':'SaveImage','inputs':{'images':['14',0],'filename_prefix':case['id']}},
 '16':{'class_type':'ModelSamplingSD3','inputs':{'model':['1',0],'shift':8.0}},
 '17':{'class_type':'LoadImage','inputs':{'image':control_name}},
 }

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['cases','comfy','python','models','text-models','output']:p.add_argument('--'+name,type=Path,required=True)
 p.add_argument('--gray-masked-region',action='store_true',help='Mark unknown pixels gray in control video as required for masked editing; retain full anchor as separate reference')
 a=p.parse_args()
 if not (a.comfy/'main.py').is_file() or not a.python.is_file():raise ValueError('ComfyUI directory or Python executable does not exist')
 cases=json.loads(a.cases.read_text(encoding='utf-8-sig'))
 if not 1<=len(cases)<=8:raise ValueError('Use one to eight bounded cases')
 for c in cases:
  if not c['id'].replace('-','').isalnum() or len(c['id'])>48:raise ValueError('Unsafe case id')
  if len(c['roi'])!=4 or not 0<=c['roi'][0]<c['roi'][2]<=512 or not 0<=c['roi'][1]<c['roi'][3]<=512:raise ValueError('Invalid ROI')
 for name,expected in MODELS.items():
  if sha(a.models/name)!=expected:raise ValueError('Unverified VACE model: '+name)
 if sha(a.text_models/'umt5_xxl_fp8_e4m3fn_scaled.safetensors')!='c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68':raise ValueError('Unverified text encoder')
 out=a.output.absolute();out.mkdir(parents=True,exist_ok=False)
 server_root=out/'server'
 for name in ['input','output','temp','user']:(server_root/name).mkdir(parents=True)
 mapping=out/'models.json';atomic_json(mapping,{'ai_pet':{'diffusion_models':str(a.models),'vae':str(a.models),'text_encoders':str(a.text_models)}})
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 server=f'http://127.0.0.1:{port}'
 command=[str(a.python),str(a.comfy/'main.py'),'--listen','127.0.0.1','--port',str(port),
  '--base-directory',str(server_root),'--user-directory',str(server_root/'user'),'--extra-model-paths-config',str(mapping),
  '--disable-auto-launch','--disable-all-custom-nodes']
 results=[];overall=time.monotonic()
 with (out/'server.log').open('w',encoding='utf-8') as log:
  process=subprocess.Popen(command,cwd=a.comfy,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
  atomic_json(out/'owned-process.json',{'pid':process.pid,'server':server,'owned':True})
  try:
   deadline=time.monotonic()+180
   while True:
    if process.poll() is not None:raise RuntimeError('Owned ComfyUI failed to start')
    try:request_json(server+'/system_stats');break
    except OSError:
     if time.monotonic()>deadline:raise TimeoutError('Server startup timeout')
     time.sleep(1)
   for case in cases:
    folder=out/case['id'];folder.mkdir()
    anchor=Path(case['anchor']);image=Image.open(anchor).convert('RGB')
    if image.size!=(512,512):raise ValueError('Anchor must be exactly 512x512')
    anchor_name=case['id']+'-anchor.png';mask_name=case['id']+'-mask.png'
    image.save(server_root/'input'/anchor_name)
    mask=Image.new('L',(512,512),0);ImageDraw.Draw(mask).rectangle(case['roi'],fill=255)
    mask=mask.filter(ImageFilter.GaussianBlur(3));mask.convert('RGB').save(server_root/'input'/mask_name)
    control_name=case['id']+'-control.png'
    control=Image.composite(Image.new('RGB',image.size,(127,127,127)),image,mask) if a.gray_masked_region else image
    control.save(server_root/'input'/control_name)
    workflow=graph(case,anchor_name,mask_name,control_name);atomic_json(folder/'workflow.json',workflow)
    report=dict(case,anchorSha256=sha(anchor),state='submitting',frames=33,fps=16,steps=20,manualROI=True,grayMaskedRegion=a.gray_masked_region,installed=False)
    started=time.monotonic();peak=None;prompt_id=None
    try:
     queued=request_json(server+'/prompt',{'prompt':workflow,'client_id':uuid.uuid4().hex});prompt_id=queued.get('prompt_id')
     if not prompt_id:raise RuntimeError('No accepted job id: '+json.dumps(queued))
     report.update(state='running',promptId=prompt_id);atomic_json(folder/'result.json',report)
     while time.monotonic()-started<900 and time.monotonic()-overall<2400:
      if process.poll() is not None:raise RuntimeError('Owned server exited')
      try:
       value=subprocess.check_output(['nvidia-smi','--query-gpu=memory.used','--format=csv,noheader,nounits'],timeout=5).decode().strip()
       used=int(value.splitlines()[0]);peak=max(used,peak or used)
      except (OSError,ValueError,subprocess.SubprocessError):pass
      history=request_json(server+'/history/'+prompt_id).get(prompt_id)
      if history:
       atomic_json(folder/'history.json',history)
       if history.get('status',{}).get('status_str')=='error':raise RuntimeError('Inference failed; see retained history')
       outputs=history.get('outputs',{}).get('15',{}).get('images',[])
       paths=result_paths(outputs,server_root/'output')
       if len(paths)!=33:raise RuntimeError('Unexpected generated frame count')
       report.update(state='candidate-needs-review',outputFrames=[str(x) for x in paths]);break
      time.sleep(3)
     else:raise TimeoutError('Bounded experiment timeout; owned server will stop')
    except Exception as e:
     report.update(state='failed',error=str(e))
    report.update(seconds=round(time.monotonic()-started,3),gpuSampledPeakTotalMiB=peak)
    atomic_json(folder/'result.json',report);results.append(report)
    atomic_json(out/'summary.json',{'cases':results,'models':MODELS,'complete':len(results)==len(cases),'installed':False})
    print(json.dumps({'case':case['id'],'state':report['state'],'seconds':report['seconds']}),flush=True)
    if time.monotonic()-overall>=2400 or report.get('error','').startswith('Bounded'):break
  finally:
   if process.poll() is None:process.terminate()
   process.wait(timeout=30)
   atomic_json(out/'process-stopped.json',{'pid':process.pid,'stopped':process.poll() is not None})

if __name__=='__main__':main()

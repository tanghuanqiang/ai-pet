"""Offline CPU landmark evidence; does not return approved motion annotations."""
import argparse,json,time,hashlib
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
from ai_edge_litert.interpreter import Interpreter
from fetch_face_landmark_experiment import MODELS

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def invoke(model,array):
    interpreter=Interpreter(model_path=str(model),num_threads=4)
    interpreter.allocate_tensors();inp=interpreter.get_input_details()[0];out=interpreter.get_output_details()[0]
    if inp['dtype']!=np.float32 or tuple(inp['shape'])!=array[None].shape:raise ValueError('Unexpected model input contract')
    interpreter.set_tensor(inp['index'],array[None]);interpreter.invoke()
    result=interpreter.get_tensor(out['index'])[0].astype(np.float32)
    if not np.isfinite(result).all():raise ValueError('Non-finite model output')
    return result
def main():
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--species',choices=('cat','dog'),required=True);p.add_argument('--models',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    output=a.output.resolve();output.mkdir(parents=True,exist_ok=False)
    started=time.perf_counter();report={'approved':False,'installable':False,'sourceSha256':sha(a.source),'species':a.species,'remoteNetworkUsed':False,'singleFaceAssumed':True,'facePointsConfirmed':False,'license':'CC-BY-NC-4.0','workerSha256':sha(Path(__file__))}
    try:
        folder=a.models/a.species;models=MODELS[a.species]
        for name,digest in models['files'].items():
            if sha(folder/name)!=digest:raise ValueError('Model fingerprint mismatch')
        report.update(modelRevision=models['revision'],modelSha256=models['files'])
        raw=Image.open(a.source).convert('RGBA');image=Image.new('RGBA',raw.size,'#808080');image.alpha_composite(raw);image=image.convert('RGB');w,h=image.size
        if min(w,h)<32 or max(w,h)>4096:raise ValueError('Unsupported source canvas')
        scale=min(224/w,224/h);nw,nh=round(w*scale),round(h*scale);px,py=(224-nw)//2,(224-nh)//2
        boxed=Image.new('RGB',(224,224));boxed.paste(image.resize((nw,nh),Image.Resampling.BILINEAR),(px,py));boxed.save(output/'localizer-input.png')
        bounds=invoke(folder/f'{a.species}_face_localizer.tflite',np.asarray(boxed,dtype=np.float32)/255)
        report['rawLocalizerOutput']=bounds.tolist()
        if bounds.shape!=(4,) or (bounds<0).any() or (bounds>1).any():raise ValueError('Invalid predicted box; no silent clipping')
        # Published inference code defines this endpoint ordering explicitly.
        bounds=np.array([min(bounds[0],bounds[2]),min(bounds[1],bounds[3]),max(bounds[0],bounds[2]),max(bounds[1],bounds[3])])
        report['boxEndpointDecoder']='sort two x endpoints and two y endpoints, as published upstream'
        box=(bounds*224-np.array([px,py,px,py]))/scale
        report['predictedBoxPixels']=box.tolist()
        x1,y1,x2,y2=box;bw,bh=x2-x1,y2-y1
        if min(bw,bh)<20:raise ValueError('Predicted face too small')
        crop=(max(0,round(x1-.1*bw)),max(0,round(y1-.1*bh)),min(w,round(x2+.1*bw)),min(h,round(y2+.1*bh)))
        if crop[2]<=crop[0] or crop[3]<=crop[1]:raise ValueError('Predicted face is outside image')
        cropped=image.crop(crop);cropped.resize((384,384),Image.Resampling.BILINEAR).save(output/'landmark-input.png')
        values=invoke(folder/f'{a.species}_face_landmarks_full.tflite',np.asarray(cropped.resize((384,384),Image.Resampling.BILINEAR),dtype=np.float32)/255)
        count=48 if a.species=='cat' else 46
        if values.shape!=(count*2,) or (values<0).any() or (values>1).any():raise ValueError('Invalid landmarks; do not silently clip')
        points=values.reshape(count,2)*np.array(cropped.size)+np.array(crop[:2]);normalized=points/np.array([w,h])
        report.update(imageSize=[w,h],cropPixels=list(crop),landmarkCount=count,pointsPixels=points.tolist(),pointsNormalized=normalized.tolist(),status='landmarks-require-review',confidenceAvailable=False)
        # A large numbered crop preserves all raw landmark identities for audit.
        canvas=cropped.resize((768,768),Image.Resampling.BILINEAR);draw=ImageDraw.Draw(canvas)
        for i,point in enumerate(values.reshape(count,2)):
            x,y=point*768;draw.ellipse((x-3,y-3,x+3,y+3),fill='#00ff00',outline='black');draw.text((x+5,y-8),str(i),fill='white',stroke_width=1,stroke_fill='black')
        canvas.save(output/'numbered-face.png')
        full=image.copy();draw=ImageDraw.Draw(full);draw.rectangle(crop,outline='red',width=3)
        for x,y in points:draw.ellipse((x-2,y-2,x+2,y+2),fill='lime')
        full.thumbnail((1100,1100));full.save(output/'full-source-review.png')
    except Exception as error:
        report.update(status='failed',error=repr(error));raise
    finally:
        report['seconds']=time.perf_counter()-started
        (output/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'status':report['status'],'landmarkCount':count,'seconds':report['seconds'],'approved':False}))
if __name__=='__main__':main()

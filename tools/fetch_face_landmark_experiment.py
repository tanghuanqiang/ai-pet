"""Explicit download for isolated non-commercial evaluation, never a runtime fetch."""
import argparse,hashlib,json,urllib.request
from pathlib import Path
MODELS={
 'cat':{'revision':'8404a7a9a98ba7752a48f55dfba0f957381ee775','files':{
  'cat_face_landmarks_full.tflite':'1a8b09c4b30a8211de89979244ab90e595935c27fdba1e64b433990f8a3a5b66',
  'cat_face_localizer.tflite':'a9621320ba8ca39b706c82649737c3cb72ef10ba37200ee91e84346600bee0c7'}},
 'dog':{'revision':'ffe69649279e0c226e7061f917550ca8608abbfe','files':{
  'dog_face_landmarks_full.tflite':'4036cd3d332f75be99e267b414ab74e08d4c3a2d4e123d5df7db543b995dcaca',
  'dog_face_localizer.tflite':'bf13f179335cec6046f5f158e218d4f5ef577f04af2896dbe8afbddc1e814b9d'}}}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
 records=[]
 for species,model in MODELS.items():
  folder=out/species;folder.mkdir()
  base=f'https://huggingface.co/hugocornellier/{species}-face-landmarks/resolve/{model["revision"]}/'
  for name in [*model['files'],'LICENSE','README.md']:
   with urllib.request.urlopen(base+name,timeout=90) as response:
    data=response.read(40*1024*1024+1)
   if len(data)>40*1024*1024:raise ValueError('Model exceeds fixed download size')
   path=folder/name;path.write_bytes(data)
   if name in model['files'] and sha(path)!=model['files'][name]:raise ValueError('Model fingerprint mismatch')
   records.append({'species':species,'file':str(path.relative_to(out)),'url':base+name,'sha256':sha(path),'bytes':len(data)})
   print(json.dumps({'file':name,'verified':True}),flush=True)
 (out/'manifest.json').write_text(json.dumps({'license':'CC-BY-NC-4.0','nonCommercialEvaluationOnly':True,'bundledWithCreator':False,'approved':False,'models':MODELS,'files':records},indent=2),encoding='utf-8')
if __name__=='__main__':main()

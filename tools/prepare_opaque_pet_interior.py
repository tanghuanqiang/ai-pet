"""Review-only alpha repair for opaque pet fur well inside a known silhouette.

Keeps RGB, outline, low-confidence pixels and transparent exterior untouched.
Not suitable for translucent accessories; does not approve source identity.
"""
import argparse,json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from transparent_head_tilt import sha
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
im=Image.open(a.source)
if im.mode!='RGBA' or max(im.size)>768:raise ValueError('Expected small, reviewed RGBA pet source')
pixels=np.asarray(im).copy();alpha=pixels[:,:,3]
if alpha.min()!=0 or alpha.max()!=255:raise ValueError('Expected transparent exterior and opaque subject')
distance=distance_transform_edt(alpha>=128)
eligible=(distance>=3)&(alpha>=200)&(alpha<255)
before=alpha.copy();pixels[eligible,3]=255
assert np.array_equal(pixels[:,:,:3],np.asarray(im)[:,:,:3])
assert np.array_equal(pixels[~eligible],np.asarray(im)[~eligible])
a.output.mkdir(parents=True,exist_ok=False);out=a.output/'UNAPPROVED-opaque-interior.png';Image.fromarray(pixels).save(out)
changes=before[eligible]
report={'approved':False,'installable':False,'sourceSha256':sha(a.source),'outputSha256':sha(out),'scriptSha256':sha(Path(__file__)),
    'route':'opaque-pet-interior-v1','minimumInputAlpha':200,'minimumSilhouetteInteriorPx':3,'rgbChangedPixels':0,
    'alphaChangedPixels':int(eligible.sum()),'changedInputAlphaMin':int(changes.min()) if changes.size else None,
    'maximumAlphaIncrease':int((255-changes).max()) if changes.size else 0,'canvas':list(im.size),
    'transparentExteriorChangedPixels':0,'outlineBandChangedPixels':0,
    'limitations':['Assumes opaque fur; not transparent material','Low-alpha holes are deliberately unchanged','Identity/fine fur/source approval still required']}
(a.output/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))

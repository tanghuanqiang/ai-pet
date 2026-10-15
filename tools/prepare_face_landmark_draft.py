"""Convert a hash-bound local landmark report into an explicitly unconfirmed draft.

Exploratory mapping v1 is evaluated on three QA photos, not a validated detector.
The draft carries all source/model fingerprints and cannot approve a theme.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from PIL import Image
from fetch_face_landmark_experiment import MODELS

GROUPS = {
    'cat': [[4], [5], [9], [8], [44, 45], [20], [18], [16], [2]],
    'dog': [[18], [16], [17], [19], [32], [43], [44], [35], [42]],
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source, report_path):
    report = json.loads(report_path.read_text(encoding='utf-8'))
    species = report.get('species')
    if species not in GROUPS or report.get('status') != 'landmarks-require-review':
        raise ValueError('Successful cat or dog model report required')
    if report.get('sourceSha256') != sha(source):
        raise ValueError('Model report belongs to another photo')
    if report.get('modelRevision') != MODELS[species]['revision'] or report.get('modelSha256') != MODELS[species]['files']:
        raise ValueError('Model provenance mismatch')
    if report.get('approved') is not False or report.get('facePointsConfirmed') is not False or report.get('remoteNetworkUsed') is not False:
        raise ValueError('Expected unconfirmed offline model evidence')
    with Image.open(source) as image:
        size = list(image.size)
    if report.get('imageSize') != size:
        raise ValueError('Model report canvas mismatch')
    points = report.get('pointsNormalized')
    count = 48 if species == 'cat' else 46
    if not isinstance(points, list) or len(points) != count or any(
        not isinstance(p, list) or len(p) != 2 or any(
            type(v) not in (int, float) or not math.isfinite(v) or not 0 < v < 1 for v in p)
        for p in points):
        raise ValueError('Invalid full model points')
    groups = GROUPS[species]
    mapped = [[sum(points[index][axis] for index in group)/len(group)
               for axis in range(2)] for group in groups]
    return dict(kind='ai-pet-face-point-draft', version=1,
                route='local-landmark-exploratory-v1', species=species,
                sourceSha256=report['sourceSha256'], imageSize=size,
                pointsNormalized=mapped, sourceIndices=groups,
                modelRevision=report['modelRevision'], modelSha256=report['modelSha256'],
                modelReportSha256=sha(report_path), mappingWorkerSha256=sha(Path(__file__)),
                license='CC-BY-NC-4.0', singleFaceAssumed=True, confidenceAvailable=False,
                remoteNetworkUsed=False, approved=False, facePointsConfirmed=False,
                installable=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    draft = prepare(args.source, args.report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as handle:
        handle.write(json.dumps(draft, indent=2))
    print(json.dumps({'species': draft['species'], 'facePointsConfirmed': False, 'approved': False}))


if __name__ == '__main__':
    main()

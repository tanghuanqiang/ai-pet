(async () => {
  const byId = (id) => document.getElementById(id);
  const ui = {
    photo: byId('hero-image'), photoInput: byId('photo-input'), name: byId('pet-name'), nameCount: byId('name-count'),
    check: byId('photo-check'), start: byId('start-creation'), creation: byId('creation-dialog'), workshop: byId('workshop-dialog'),
    petDialog: byId('pet-dialog'), toast: byId('toast'), dialogImage: byId('dialog-image'), workshopImage: byId('workshop-image'), petImage: byId('pet-modal-image'),
  };
  const fallbackPhoto = './reference-cat.jpg';
  let photoSource = fallbackPhoto;
  let headTiltPhotoSource = null;
  let wanAnchorPhoto = null;
  let referencePhotos = [];
  let pendingReferencePromotion = null;
  let bundledCopyPhoto = fallbackPhoto;
  let bundledCopyStatus = 'yes';
  let bundledReferenceImagePromise = null;
  function primaryIsBundledCrop(photo = photoSource) {
    return photo === fallbackPhoto || (photo === bundledCopyPhoto && bundledCopyStatus === 'yes');
  }
  function primaryDiffersFromBundledCrop(photo = photoSource) {
    return photo !== fallbackPhoto && photo === bundledCopyPhoto && bundledCopyStatus === 'no';
  }
  function imageThumbnail(image) {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    canvas.getContext('2d').drawImage(image, 0, 0, 40, 40);
    return canvas.getContext('2d').getImageData(0, 0, 40, 40).data;
  }
  async function refreshBundledCopyStatus(photo) {
    if (photo === fallbackPhoto) {
      bundledCopyPhoto = photo;
      bundledCopyStatus = 'yes';
      return;
    }
    bundledCopyPhoto = photo;
    bundledCopyStatus = 'pending';
    renderReferencePhotos();
    renderActionSuitability();
    try {
      bundledReferenceImagePromise ||= imageFromSource(fallbackPhoto);
      const [reference, candidate] = await Promise.all([bundledReferenceImagePromise, imageFromSource(photo)]);
      if (photo !== photoSource) return;
      const ratioReference = reference.naturalWidth / reference.naturalHeight;
      const ratioCandidate = candidate.naturalWidth / candidate.naturalHeight;
      const referencePixels = imageThumbnail(reference);
      const candidatePixels = imageThumbnail(candidate);
      let totalDifference = 0;
      for (let index = 0; index < referencePixels.length; index += 4) {
        for (let channel = 0; channel < 3; channel++)
          totalDifference += Math.abs(referencePixels[index + channel] - candidatePixels[index + channel]);
      }
      bundledCopyStatus = Math.abs(ratioReference - ratioCandidate) <= 0.015 &&
        totalDifference / (40 * 40 * 3) <= 12 ? 'yes' : 'no';
    } catch {
      if (photo !== photoSource) return;
      bundledCopyStatus = 'unknown';
    }
    if (bundledCopyStatus === 'yes' && sourceEvidence.includes('fullSilhouette'))
      setSourceEvidence(sourceEvidence.filter((part) => part !== 'fullSilhouette'));
    renderReferencePhotos();
    renderPhotoCoverageNotice();
    renderActionSuitability();
  }
  function selectedSegmentationSource() {
    const value = byId('segmentation-photo-source')?.value || 'primary';
    const match = /^reference-(\d+)$/.exec(value);
    const item = match ? referencePhotos[Number(match[1])] : null;
    return item ? { key: value, photo: item.photo, photoName: item.photoName } : { key: 'primary', photo: photoSource, photoName };
  }
  function syncSegmentationPhotoOptions() {
    const select = byId('segmentation-photo-source');
    const wrap = byId('segmentation-photo-source-wrap');
    if (!select || !wrap) return;
    const changed = select.value !== 'primary' && select.value !== '';
    select.replaceChildren(new Option(`主照片 · ${photoName}`, 'primary'));
    referencePhotos.forEach((item, index) => select.add(new Option(item.photoName, `reference-${index}`)));
    select.value = 'primary';
    wrap.hidden = referencePhotos.length === 0;
    if (changed) resetSegmentationForPhotoChange(selectedSegmentationSource());
  }
  function resetSegmentationForPhotoChange(selected) {
    sam2PromptState.foreground = [];
    sam2PromptState.background = [];
    sam2PromptState.photo = selected.photo;
    invalidateSegmentationCandidate();
    byId('segmentation-status').textContent = `${selected.photoName} 已选为本次单图分割输入；不会替换角色主照片。`;
    renderSam2PromptCanvas();
  }
  let segmentationPreviewPhoto = null;
  let segmentationVariants = [];
  let segmentationPackageUrl = '';
  let segmentationCandidateRevision = 0;
  let matteComparison = null;
  function clearMatteComparison() {
    matteComparison = null;
    byId('matte-comparison').hidden = true;
    byId('matte-refine-status').textContent = '可生成一份毛边细化候选，与当前蒙版比较；不会补全身体。照片和候选仅保存到本机制作目录。';
  }
  let portraitFraming = null;
  function clearPortraitFraming() {
    portraitFraming = null;
    const review = byId('photo-wink-framing-review');
    if (review) review.hidden = true;
    const confirm = byId('photo-wink-framing-confirm');
    if (confirm) confirm.checked = false;
  }
  function clearSegmentationPackageLink() {
    const link = byId('download-static-theme');
    link.hidden = true;
    byId('static-package-instructions').hidden = true;
    link.removeAttribute('href');
    if (segmentationPackageUrl) URL.revokeObjectURL(segmentationPackageUrl);
    segmentationPackageUrl = '';
  }
  const segmentationEditor = { canvas: null, originalPixels: null, sourcePixels: null, sourceImage: null, edgeReview: null, regionReview: null, promptReview: null, candidateLabel: '', undo: [], mode: 'erase', activeStroke: null, lastPoint: null, changed: false };
  function invalidateSegmentationCandidate() {
    clearMatteComparison();
    segmentationCandidateRevision += 1;
    clearPortraitFraming();
    clearSegmentationPackageLink();
    segmentationPreviewPhoto = null;
    segmentationVariants = [];
    byId('segmentation-variants').replaceChildren();
    byId('segmentation-variants').hidden = true;
    byId('segmentation-result').hidden = true;
    byId('segmentation-editor').hidden = true;
    byId('segmentation-edit-toggle').setAttribute('aria-expanded', 'false');
    segmentationEditor.canvas = null;
    segmentationEditor.originalPixels = null;
    segmentationEditor.sourcePixels = null;
    segmentationEditor.sourceImage = null;
    segmentationEditor.edgeReview = null;
    segmentationEditor.regionReview = null;
    segmentationEditor.promptReview = null;
    segmentationEditor.undo = [];
    segmentationEditor.changed = false;
    renderActionSuitability();
    byId('segmentation-capabilities').hidden = true;
    byId('segmentation-capabilities').textContent = '';
  }
  const sam2PromptState = { mode: 'foreground', foreground: [], background: [], photo: '' };
  const sam2VideoState = { file: null, url: '', duration: 0, width: 0, height: 0, fps: 25, mode: 'foreground', foreground: [], background: [], firstFrame: null, sourceKey: '', selectionRevision: 0, history: [], historySaved: true, reviewSyncWarning: false, selectedCandidateId: '', busy: false };
  let photoWinkCandidate = null;
  let photoWinkBusy = false;
  let photoWinkController = null;
  let photoWinkRequestId = '';
  let photoWinkServerJobStarted = false;
  let wanCandidate = null;
  let wanBusy = false;
  let lastAutoWanPositive = '';
  const wanHistoryKey = 'littleOrbit.wanRgbCandidates.v1';
  let wanHistory = [];
  let wanHistoryPanel = null;
  const portraitHistoryKey = 'littleOrbit.photoWinkHistory.v1';
  const xposeConsentKey = 'littleOrbit.xposeResearchConsent.v1';
  let xposeResearchConsent = (() => {
    try { return sessionStorage.getItem(xposeConsentKey) === 'accepted'; }
    catch { return false; }
  })();
  const manualFaceLabels = ['画面左眼外侧', '画面左眼内侧', '画面右眼内侧', '画面右眼外侧', '鼻尖', '画面左口角', '画面右口角', '上唇中点', '下唇中点'];
  const manualFace = { photo: '', points: [], viewBox: [0, 0, 1, 1], choosingZoom: false, editingIndex: null, draftEvidence: null };
  let manualFaceStorageBusy=false;
  let faceBackendReady=false;
  const manualFaceStorageKey='littleOrbit.faceAnnotations.v1';
  const manualFaceTools=document.createElement('div');
  manualFaceTools.innerHTML='<label>修正点位 <select id="photo-wink-manual-edit" aria-label="修正点位"><option value="">选择需修正的位置</option></select></label><button id="photo-wink-manual-save" class="secondary-button" type="button">保存已核对点位</button><button id="photo-wink-manual-load" class="secondary-button" type="button">打开当前照片点位</button><p id="photo-wink-manual-storage-status" role="status">点位按当前照片指纹保存在本机；重开后须重新核对。</p>';
  byId('photo-wink-manual-panel').append(manualFaceTools);
  const draftLabel=document.createElement('label');draftLabel.className='face-draft-input-label';draftLabel.textContent='打开本机模型点位草稿（实验，须逐点核对）';
  const draftInput=document.createElement('input');draftInput.id='photo-wink-manual-draft';draftInput.type='file';draftInput.accept='.json,application/json';draftLabel.append(draftInput);manualFaceTools.append(draftLabel);
  const faceControls=document.createElement('div');faceControls.className='face-local-controls';
  faceControls.innerHTML='<label>当前照片中的宠物 <select id="photo-face-species"><option value="cat">猫</option><option value="dog">狗</option></select></label><button id="photo-face-run" class="secondary-button" type="button" disabled>本机定位九点（实验）</button><p id="photo-face-backend-status" role="status">正在检查本机定位模型……</p><details><summary>配置本机面部模型</summary><label class="face-draft-input-label">模型目录 <input id="photo-face-backend-root" type="text" maxlength="1024" placeholder="已准备本机模型的目录"></label><button id="photo-face-backend-save" class="secondary-button" type="button">保存目录</button><button id="photo-face-backend-disable" class="secondary-button" type="button">停用定位</button><p>需另行准备匹配的 CPU 环境与猫狗权重；安装包不含模型。CC-BY-NC-4.0，仅本机非商用实验。照片留在本机，保留定位审查图与日志；模型不提供置信度或宠物数量证明。</p></details>';
  manualFaceTools.append(faceControls);
  manualFaceLabels.forEach((label,index)=>{const o=document.createElement('option');o.value=String(index);o.textContent=`${index+1} · ${label}`;byId('photo-wink-manual-edit').append(o);});
  const manualWinkSelected = () => byId('photo-wink-manual-mode').checked;
  function manualFaceGeometryValid() {
    if (manualFace.points.length !== 9) return false;
    const left = (manualFace.points[0][0] + manualFace.points[1][0]) / 2;
    const right = (manualFace.points[2][0] + manualFace.points[3][0]) / 2;
    return right - left >= 0.015 && right - left <= 0.7 &&
      ui.photo.naturalWidth > 0 && (right - left) * ui.photo.naturalWidth >= 24;
  }
  function manualFaceReady() {
    return manualFace.photo === photoSource && manualFace.editingIndex===null && manualFaceGeometryValid() && byId('photo-wink-manual-confirm').checked;
  }
  function renderManualFace() {
    const panel = byId('photo-wink-manual-panel');
    panel.hidden = !manualWinkSelected();
    document.querySelector('.photo-wink-license-consent').hidden = manualWinkSelected();
    if (manualFace.photo !== photoSource) {
      manualFace.photo = photoSource;
      manualFace.points = [];
      manualFace.viewBox = [0, 0, 1, 1];
      manualFace.choosingZoom = false;
      manualFace.editingIndex = null;
      manualFace.draftEvidence = null;
      byId('photo-wink-manual-edit').value='';
      byId('photo-wink-manual-storage-status').textContent='当前照片点位尚未打开；可读取本机保存的同一照片点位，重开后须核对。';
      byId('photo-wink-manual-confirm').checked = false;
    }
    const canvas = byId('photo-wink-manual-canvas');
    const imageReady = ui.photo.complete && ui.photo.naturalWidth > 0 &&
      ui.photo.currentSrc === new URL(photoSource, document.baseURI).href;
    if (imageReady && manualWinkSelected()) {
      const scale = Math.min(1, 480 / ui.photo.naturalWidth, 560 / ui.photo.naturalHeight);
      canvas.width = Math.max(1, Math.round(ui.photo.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(ui.photo.naturalHeight * scale));
      const context = canvas.getContext('2d');
      const [left, top, right, bottom] = manualFace.viewBox;
      context.drawImage(ui.photo, left * ui.photo.naturalWidth, top * ui.photo.naturalHeight,
        (right - left) * ui.photo.naturalWidth, (bottom - top) * ui.photo.naturalHeight,
        0, 0, canvas.width, canvas.height);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = 'bold 12px sans-serif';
      manualFace.points.forEach(([x, y], index) => {
        if (x < left || x > right || y < top || y > bottom) return;
        const px = (x - left) / (right - left) * canvas.width;
        const py = (y - top) / (bottom - top) * canvas.height;
        context.beginPath();
        context.arc(px, py, 9, 0, 2 * Math.PI);
        context.fillStyle = '#fff9ea';
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = '#af5a31';
        context.stroke();
        context.fillStyle = '#783e24';
        context.fillText(String(index + 1), px, py + 0.5);
      });
    }
    byId('photo-wink-manual-step').textContent = !imageReady ? '正在载入当前照片……' : manualFace.choosingZoom
      ? '点击照片中脸部的中心位置；画布随后放大四倍。' :
      manualFace.editingIndex!==null ? `请点击第 ${manualFace.editingIndex+1} 点「${manualFaceLabels[manualFace.editingIndex]}」的新位置；其他点保留。` :
      manualFace.points.length < 9 ? `第 ${manualFace.points.length + 1}/9 点：${manualFaceLabels[manualFace.points.length]}` :
      !manualFaceGeometryValid() ? '两眼的点位顺序或间距不合理；请撤销后重新标注。' :
      manualFaceReady() ? '九点已核对，可生成本机待审视频。' : '九点已标完；请核对位置并勾选确认。';
    byId('photo-wink-manual-undo').disabled = photoWinkBusy || manualFace.points.length === 0;
    byId('photo-wink-manual-clear').disabled = photoWinkBusy || manualFace.points.length === 0;
    byId('photo-wink-manual-zoom').disabled = photoWinkBusy || !imageReady;
    byId('photo-wink-manual-zoom').textContent = manualFace.choosingZoom ? '取消放大选择' :
      manualFace.viewBox[2] < 1 ? '查看整张照片' : '放大脸部区域';
    byId('photo-wink-manual-confirm').disabled = photoWinkBusy || manualFace.editingIndex!==null || !manualFaceGeometryValid();
    byId('photo-wink-manual-edit').disabled=photoWinkBusy || manualFace.points.length!==9;
    byId('photo-wink-manual-save').disabled=photoWinkBusy || manualFaceStorageBusy || !manualFaceReady() || manualFace.editingIndex!==null;
    byId('photo-wink-manual-load').disabled=photoWinkBusy || manualFaceStorageBusy || !imageReady;
    draftInput.disabled=photoWinkBusy || manualFaceStorageBusy || !imageReady;
    byId('photo-face-run').disabled=photoWinkBusy || manualFaceStorageBusy || !imageReady || !faceBackendReady;
    ['photo-face-species','photo-face-backend-root','photo-face-backend-save','photo-face-backend-disable'].forEach(id=>{byId(id).disabled=photoWinkBusy || manualFaceStorageBusy;});
  }
  const legacyWinkMultipliers = { gentle: 1.25, standard: 1.5, expressive: 1.75 };
  let portraitHistory = [];
  let portraitHistoryLoaded = false;
  let portraitPhotoKey = '';
  let portraitLegacyPhotoKey = '';
  let portraitKeyRevision = 0;
  let photoName = '在木架间发现一只小猫';
  let sourceEvidence = ['face', 'frontPaws'];
  let photoReview = { subjectCount: 'uncertain', occlusion: 'uncertain' };
  let mode = 'real';
  let currentAction = '眨眨眼';
  let aiPlanController = null;
  let aiPlanRequestId = '';
  let aiPlanBusy = false;
  let aiPlanRecord = null;
  let aiWinkApplied = null;
  let activeReviewCandidate = null;
  let roleVideoContext = null;
  let toastTimer;
  let exportCardObjectUrl = '';
  let savedCharacter = null;
  let savedCharacters = [];
  let editingCharacterId = null;
  let selectedRoleVersionId = '';
  const maxRoleVersions = 10;
  const defaultPrompts = {
    real: {
      '眨眨眼': '像刚睡醒一样，慢慢眨一下眼睛，保留它原来的眼睛和花纹。',
      '歪头看看': '像听到熟悉的声音一样，轻轻歪一下头，保留它原来的眼睛和花纹。',
      '打个招呼': '只让照片中已确认的前爪轻轻抬起打招呼，保留脸部和花纹；不补画被遮挡的身体。',
    },
    original: {
      '眨眨眼': '给这个原创角色设计一次轻柔的眨眼，保留设定中的眼睛和花纹。',
      '歪头看看': '给这个原创角色设计一个轻柔、好辨认的歪头动作。',
      '打个招呼': '给这个原创角色设计一个轻柔、好辨认的打招呼动作。',
    },
  };
  const defaultPromptFor = (petMode, action) => defaultPrompts[petMode]?.[action] || '';
  const isDefaultPrompt = (value) => {
    const names = [ui.name.value.trim(), '小伙伴'].filter(Boolean);
    return Object.values(defaultPrompts).some((prompts) => Object.values(prompts).some((prompt) =>
      prompt === value || names.some((name) => prompt.replaceAll('它', name) === value)));
  };
  const realPetPrompt = defaultPromptFor('real', '眨眨眼');
  const originalPrompt = defaultPromptFor('original', '眨眨眼');
  const defaultWanMotion = {
    '眨眨眼': 'Over about two seconds, close both eyelids once and reopen them, then settle into the exact starting expression. Keep the head, paws and torso anchored; a very small chest breath is acceptable.',
    '歪头看看': 'Over about three seconds, the head tilts gently around the neck by roughly ten degrees, the ears follow, then the head returns to neutral. Keep the shoulders, paws and torso fixed in place; do not rotate the whole character.',
    '打个招呼': 'One already visible front paw rises slightly, bends naturally at its joints, makes one small greeting motion and returns to its original contact point. Keep the other paws, head and torso stable; do not invent a hidden paw.',
  };
  function buildWanPositive(snapshot) {
    const evidence = JSON.parse(snapshot.sourceEvidence);
    if (snapshot.mode === 'real' && snapshot.action === '打个招呼' && !evidence.includes('frontPaws'))
      return 'A front paw has not been confirmed visible in the reference photo. Add and confirm a clear visible-paw reference before generating a paw greeting for this real pet. No animation candidate is permitted from the current evidence.';
    const identity = snapshot.mode === 'real'
      ? "Preserve this photographed pet's face, eye shape, markings, fur colors, collar and other visible accessories exactly. Treat any body region absent from the photo as an unverified design choice; keep the supplied anchor consistent rather than changing identity."
      : 'Preserve the selected original character design, face, markings and accessories consistently across every frame.';
    return [snapshot.prompt, defaultWanMotion[snapshot.action], identity,
      'One anatomically coherent pet. Keep the full supplied anchor silhouette inside the frame with a locked camera, fixed scale and stable lighting. Start in the anchor pose, make the named local action readable at 190px normal speed, and return smoothly to the same pose. No background, text or other characters.'].filter(Boolean).join(' ');
  }
  function refreshWanPositive(snapshot) {
    const field = byId('wan-positive');
    const current = field.value.trim();
    if (current && current !== lastAutoWanPositive) return;
    field.value = buildWanPositive(snapshot);
    lastAutoWanPositive = field.value;
  }
  const knownTraits = ['橘白相间的短毛', '粉色鼻头与圆眼睛', '脖子上戴着项圈'];
  const evidenceParts = ['face', 'frontPaws', 'rearPaws', 'tail', 'fullSilhouette'];
  function normalizePhotoReview(value) {
    const review = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      subjectCount: ['one', 'multiple', 'uncertain'].includes(review.subjectCount) ? review.subjectCount : 'uncertain',
      occlusion: ['clear', 'present', 'uncertain'].includes(review.occlusion) ? review.occlusion : 'uncertain',
    };
  }
  function setPhotoReview(value, persist = false) {
    photoReview = normalizePhotoReview(value);
    document.querySelectorAll('[name="review-subject"]').forEach((input) => { input.checked = input.value === photoReview.subjectCount; });
    document.querySelectorAll('[name="review-occlusion"]').forEach((input) => { input.checked = input.value === photoReview.occlusion; });
    renderActionSuitability();
    if (roleVideoContext) renderRoleVideoContext();
    if (persist) persistDraft();
  }
  function normalizeReferencePhotos(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 3).filter((item) => item && typeof item === 'object' && !Array.isArray(item) &&
      isLocalPhoto(item.photo) && item.photo !== fallbackPhoto && typeof item.photoName === 'string' && item.photoName.length <= 180)
      .map((item) => ({ photo: item.photo, photoName: item.photoName }));
  }
  function hasAdditionalView(photo = photoSource) {
    return photo !== fallbackPhoto && !primaryIsBundledCrop(photo);
  }
  function normalizeSourceEvidence(value, photo, photos = referencePhotos) {
    if (!Array.isArray(value)) return photo === fallbackPhoto ? ['face', 'frontPaws'] : [];
    const parts = evidenceParts.filter((part) => value.includes(part));
    return hasAdditionalView(photo, photos) ? parts : parts.filter((part) => part !== 'fullSilhouette');
  }
  function openReferencePromotion(index) {
    const candidate = referencePhotos[index];
    if (!candidate) return;
    pendingReferencePromotion = { index, candidatePhoto: candidate.photo, currentPhoto: photoSource };
    byId('reference-identity-current').src = photoSource;
    byId('reference-identity-next').src = candidate.photo;
    byId('reference-identity-next-name').textContent = candidate.photoName;
    byId('reference-identity-confirm').checked = false;
    byId('reference-identity-apply').disabled = true;
    byId('reference-photo-identity-dialog').showModal();
  }
  function applyReferencePromotion() {
    const pending = pendingReferencePromotion;
    if (!pending || !byId('reference-identity-confirm').checked) return;
    const next = referencePhotos[pending.index];
    if (!next || next.photo !== pending.candidatePhoto || photoSource !== pending.currentPhoto) {
      byId('reference-photo-identity-dialog').close();
      tell('参考照片已变化，请重新核对同宠身份。');
      return;
    }
    byId('reference-photo-identity-dialog').close();
    const previous = { photo: photoSource, photoName };
    referencePhotos.splice(pending.index, 1);
    if (previous.photo !== fallbackPhoto) referencePhotos.unshift(previous);
    photoSource = next.photo;
    photoName = next.photoName;
    updateImages(photoSource);
    byId('photo-caption-name').textContent = photoName;
    setPhotoReview(undefined);
    setSourceEvidence([]);
    renderReferencePhotos();
    persistDraft();
    tell('已切换主照片；同宠身份由你人工确认，请重新检查可见部位和裁切。');
  }
  function renderReferencePhotos() {
    const list = byId('reference-photo-list');
    const count = 1 + referencePhotos.length;
    byId('reference-photo-count').textContent = `目前 ${count} 张 · 最多 4 张`;
    document.querySelector('.photo-counter span:last-child').textContent = String(count).padStart(2, '0');
    list.replaceChildren();
    list.hidden = referencePhotos.length === 0;
    byId('add-reference-photos').disabled = referencePhotos.length >= 3;
    const framingAdd = byId('photo-framing-add');
    framingAdd.disabled = referencePhotos.length >= 3;
    framingAdd.textContent = referencePhotos.length >= 3 ? '已到上限 · 可将全身照设为主照片' :
      referencePhotos.length ? '再补充同宠全身照片 ↗' : '补充同宠全身照片 ↗';
    referencePhotos.forEach((item, index) => {
      const tile = document.createElement('div');
      tile.className = 'reference-photo-item';
      const image = document.createElement('img');
      image.src = item.photo;
      image.alt = `补充视角：${item.photoName}`;
      const promote = document.createElement('button');
      promote.type = 'button';
      promote.className = 'reference-photo-primary';
      promote.title = '设为主照片';
      promote.setAttribute('aria-label', `将 ${item.photoName} 设为主照片`);
      promote.textContent = '↥';
      promote.addEventListener('click', () => openReferencePromotion(index));
      const remove = document.createElement('button');
      remove.className = 'reference-photo-remove';
      remove.type = 'button';
      remove.title = `移除 ${item.photoName}`;
      remove.setAttribute('aria-label', `移除补充照片 ${item.photoName}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        referencePhotos.splice(index, 1);
        referencePhotos = normalizeReferencePhotos(referencePhotos);
      setPhotoReview(undefined);
        setSourceEvidence([]);
        renderReferencePhotos();
        persistDraft();
        tell('已移除补充照片；请重新确认可见部位。');
      });
      const label = document.createElement('span');
      label.textContent = item.photoName;
      tile.append(image, promote, remove, label);
      list.append(tile);
    });
    syncSegmentationPhotoOptions();
    const fullSilhouette = document.querySelector('[data-evidence-part="fullSilhouette"]');
    if (fullSilhouette) fullSilhouette.disabled = !primaryDiffersFromBundledCrop();
  }
  function renderPhotoCoverageNotice() {
    const note = byId('photo-framing-note');
    const sample = primaryIsBundledCrop();
    note.dataset.sampleCopy = photoSource === fallbackPhoto ? 'yes' : bundledCopyStatus;
    note.hidden = !sample && primaryDiffersFromBundledCrop() && sourceEvidence.includes('fullSilhouette');
    note.querySelector('strong').textContent = sample ? '参考照片的取景限制' : '照片完整轮廓尚未确认';
    note.querySelector('p').lastChild.textContent = sample
      ? referencePhotos.length
        ? '主照片右侧身体被裁断。请核对补充照片是否为同一只宠物、四肢和尾巴是否入画；若完整，点击照片上的 ↑ 设为主照片，再重新确认照片内容。画外身体不会自动补画。'
        : '这张图适合确认脸部、花纹和项圈；猫身被右侧画框裁断，并与木架相连。请补充同一只宠物的无遮挡全身照，让四肢、尾巴和身体边缘都在画面内。画外身体不会自动补画。'
      : '目前只记录已确认可见的部位。若生成全身候选，未拍到的部位要标为推断；请补充轮廓完整的照片或继续审核幻想版本。';
  }
  function fullBodyPhotoEligible() {
    return primaryDiffersFromBundledCrop() && sourceEvidence.includes('fullSilhouette') &&
      sourceEvidence.includes('face') && photoReview.subjectCount === 'one' && photoReview.occlusion === 'clear';
  }
  function portraitFramingIsCurrent() {
    return !!portraitFraming && portraitFraming.photo === photoSource &&
      portraitFraming.revision === segmentationCandidateRevision &&
      portraitFraming.canvas === segmentationEditor.canvas &&
      segmentationPreviewPhoto === photoSource && !byId('segmentation-result').hidden &&
      segmentationEditor.sourceImage?.naturalWidth === portraitFraming.sourceSize[0] &&
      segmentationEditor.sourceImage?.naturalHeight === portraitFraming.sourceSize[1] &&
      byId('photo-wink-preserve-body').checked && fullBodyPhotoEligible();
  }
  function renderActionSuitability() {
    const faceVisible = sourceEvidence.includes('face');
    const frontPawsVisible = sourceEvidence.includes('frontPaws');
    const singleSubjectConfirmed = photoReview.subjectCount === 'one';
    const fullBodyEligible = fullBodyPhotoEligible();
    const note = byId('action-evidence-note');
    note.classList.toggle('needs-evidence', currentAction === '打个招呼' ? !frontPawsVisible : !faceVisible);
    note.textContent = currentAction === '眨眨眼'
      ? faceVisible
        ? '脸部已确认可见；本机可试做待审眨眼，身份与透明边缘仍需单独审核。'
        : '照片尚未确认脸部可见；请在角色卡中核对脸和双耳。也可用已有视频制作待审候选。'
      : currentAction === '歪头看看'
        ? faceVisible
          ? '脸部已确认可见；歪头动作仍需要已有视频或其他合格生成路线，并逐帧审核。'
          : '照片尚未确认脸部可见；歪头动作缺少身份锚点。请补图，或将结果明确标为推断版本。'
        : frontPawsVisible
          ? '前爪已确认可见；打招呼仍需要已有视频或其他合格生成路线，并检查肢体与遮挡。'
          : '照片尚未确认前爪可见；打招呼需要补充前爪照片，或将结果明确标为推断版本。';
    const winkButton = byId('photo-wink-run');
    const licenseConsent = byId('photo-wink-license-consent');
    renderManualFace();
    const routeReady = manualWinkSelected() ? manualFaceReady() : xposeResearchConsent;
    const currentCandidateAccessible = photoWinkCandidate &&
      (photoWinkCandidate.landmarkRoute === 'manual-nine-point' || xposeResearchConsent);
    licenseConsent.checked = xposeResearchConsent;
    licenseConsent.disabled = photoWinkBusy;
    winkButton.textContent = photoWinkBusy ? '取消本机生成' : '从照片生成眨眼预览';
    winkButton.setAttribute('aria-label', winkButton.textContent);
    byId('photo-wink-strength').disabled = photoWinkBusy;
    byId('photo-wink-source-scale').disabled = photoWinkBusy;
    byId('photo-wink-manual-mode').disabled = photoWinkBusy;
    const preserveBody = byId('photo-wink-preserve-body');
    if (!fullBodyEligible && !photoWinkBusy) {
      preserveBody.checked = false;
      clearPortraitFraming();
    }
    preserveBody.disabled = photoWinkBusy || !fullBodyEligible;
    preserveBody.title = fullBodyEligible ? '仅保留主照片已有轮廓，输出仍带背景' : '请换成完整主照片，并确认一只宠物、脸部、完整轮廓及无遮挡';
    const framingReview = byId('photo-wink-framing-review');
    const framingCurrent = portraitFramingIsCurrent();
    byId('photo-wink-framing-prepare').disabled = photoWinkBusy || !fullBodyEligible || !preserveBody.checked ||
      segmentationPreviewPhoto !== photoSource || !segmentationEditor.canvas || byId('segmentation-result').hidden;
    byId('photo-wink-framing-confirm').disabled = photoWinkBusy || !framingCurrent;
    byId('photo-wink-framing-cancel').disabled = photoWinkBusy;
    winkButton.disabled = !photoWinkBusy && (!routeReady || currentAction !== '眨眨眼' || !faceVisible ||
      !singleSubjectConfirmed || (!framingReview.hidden && (!framingCurrent || !byId('photo-wink-framing-confirm').checked)));
    byId('photo-wink-use').disabled = !currentCandidateAccessible ||
      (photoWinkCandidate.composition === 'full-image-pasteback' && !fullBodyEligible);
    byId('photo-wink-result').hidden = !currentCandidateAccessible;
    byId('photo-wink-evidence-note').textContent = manualWinkSelected() && !manualFaceReady()
      ? '请在当前照片上完成九点面部标注并核对；此路线跳过 X-Pose 检测，但仍要审查输出和模型分发许可。'
      : !manualWinkSelected() && !xposeResearchConsent
      ? '请先查看并确认 X-Pose 仅限非商业科研的许可证；确认只保存在当前浏览器会话。'
      : !singleSubjectConfirmed
      ? '请先由你确认参考照片里是一只宠物；主体数量未确认时，本机单宠眨眼路线暂停。'
      : faceVisible
        ? '照片中已确认脸部可见且只有一只宠物；本机输出仍是待审视频。'
        : '尚未确认照片中脸部可见；本机照片眨眼路线暂停。请先核对角色卡或更换照片。';
    if (!activeReviewCandidate) byId('backend-notice-text').textContent = defaultWorkshopBackendNotice();
  }
  function refreshPromptPlanPreview() {
    const prompt = byId('prompt-input')?.value || '';
    const wholeBodyTerms = ['全身', '跑', '奔跑', '跳', '走动', '翻滚', '转圈', '巡逻', '尾巴', '伸懒腰'];
    const appearanceTerms = ['换装', '穿上', '衣服', '服装', '变身', '卡通', '像素风', '幻想'];
    const requestedWholeBody = wholeBodyTerms.filter((term) => prompt.includes(term));
    const requestedAppearanceChange = appearanceTerms.filter((term) => prompt.includes(term));
    const scope = byId('prompt-plan-scope');
    const route = byId('prompt-plan-route');
    const warning = byId('prompt-plan-warning');
    if (!scope || !route || !warning) return;
    scope.textContent = requestedWholeBody.length ? `可能涉及全身动作（${[...new Set(requestedWholeBody)].join('、')}）` : currentAction === '打个招呼' ? '前爪局部动作' : '脸部局部动作';
    route.textContent = currentAction === '眨眨眼'
      ? (manualWinkSelected() ? '固定本机眨眼模板；九点标注跳过 X-Pose，候选仍需审核' : '固定本机眨眼模板；不执行自由 Prompt（X-Pose 仅限非商业科研）')
      : currentAction === '歪头看看' ? '透明角色歪头模板；可编辑方向、幅度和时长，需先确认形体及脸部标注'
        : '导入并标记与计划相符的已有视频；尚无通用抬爪生成模板';
    const notices = [];
    if (requestedWholeBody.length) notices.push('当前没有从照片生成全身动作的路线；请选择匹配视频或修改描述。');
    if (requestedAppearanceChange.length && mode === 'real') notices.push('描述可能改变真实宠物外观；身份保护模式不会生成这些外观改动。');
    if (currentAction !== '眨眨眼' && !sourceEvidence.includes(currentAction === '打个招呼' ? 'frontPaws' : 'face')) {
      notices.push(currentAction === '打个招呼' ? '照片尚未确认前爪；请补充可见前爪的参考图。' : '照片尚未确认脸部；请补充清晰的脸部参考图。');
    }
    warning.hidden = notices.length === 0;
    warning.textContent = notices.join(' ');
    warning.setAttribute('aria-live', 'polite');
  }
  function aiPlanContext() {
    return {
      action: currentAction,
      mode,
      prompt: byId('prompt-input').value.trim(),
      traits: knownTraits.filter((_, index) => document.querySelectorAll('.trait-list input')[index]?.checked),
      evidence: [...sourceEvidence],
    };
  }
  function cancelAiPlan() {
    if (!aiPlanController) return;
    aiPlanController.abort();
    if (aiPlanRequestId) fetch('http://127.0.0.1:4178/api/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: aiPlanRequestId }), keepalive: true,
    }).catch(() => {});
  }
  function invalidateAiPlan() {
    cancelAiPlan();
    aiPlanRecord = null;
    aiWinkApplied = null;
    byId('ai-plan-result').hidden = true;
    byId('ai-plan-edit').value = '';
    byId('ai-wink-apply').hidden = true;
    byId('ai-wink-apply-status').textContent = '';
    byId('photo-wink-plan-note').hidden = true;
    byId('ai-plan-status').textContent = '描述或角色依据已变化；旧文字计划已撤销。';
  }
  async function runAiPlan() {
    if (aiPlanBusy) {
      cancelAiPlan();
      return;
    }
    if (!byId('ai-plan-consent').checked) return;
    const context = aiPlanContext();
    if (!context.prompt || context.prompt.length > 1200) {
      byId('ai-plan-status').textContent = '请填写不超过 1200 字的动作描述。';
      return;
    }
    const contextKey = JSON.stringify(context);
    aiPlanController = new AbortController();
    aiPlanRequestId = [...crypto.getRandomValues(new Uint8Array(16))].map((part) => part.toString(16).padStart(2, '0')).join('');
    aiPlanBusy = true;
    byId('ai-plan-run').textContent = '取消文字计划';
    byId('ai-plan-result').hidden = true;
    const status = byId('ai-plan-status');
    try {
      status.textContent = '正在检查本机 Codex 计划服务；尚未发送文字……';
      const capabilitiesResponse = await fetch('http://127.0.0.1:4178/api/capabilities', {
        signal: AbortSignal.any([aiPlanController.signal, AbortSignal.timeout(8000)]),
      });
      const capabilities = await capabilitiesResponse.json();
      if (!capabilitiesResponse.ok || capabilities.ready !== true || capabilities.task !== 'text-only-action-plan' ||
          capabilities.provider !== 'OpenAI Codex CLI' || capabilities.model !== 'gpt-6-luna' ||
          capabilities.photoSent !== false || capabilities.promptSentToProvider !== true ||
          capabilities.reviewRequired !== true || capabilities.installable !== false)
        throw new Error('本机 Codex 文字计划服务未就绪或隐私声明不符。');
      if (JSON.stringify(aiPlanContext()) !== contextKey || !byId('ai-plan-consent').checked)
        throw new Error('角色或描述已经变化，请重新发起。');
      status.textContent = '正在生成文字动作计划；照片没有发送。';
      const response = await fetch('http://127.0.0.1:4178/api/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: aiPlanRequestId, ...context,
          consent: { accepted: true, provider: 'OpenAI Codex CLI', photoSent: false } }),
        signal: AbortSignal.any([aiPlanController.signal, AbortSignal.timeout(115000)]),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '文字计划服务失败。');
      const actionCode = { '眨眨眼': 'wink', '歪头看看': 'head-tilt', '打个招呼': 'wave' }[context.action];
      if (JSON.stringify(aiPlanContext()) !== contextKey || !byId('ai-plan-consent').checked)
        throw new Error('生成期间角色或描述已变化；旧计划不会展示。');
      if (result.status !== 'plan-requires-human-review' || result.model !== 'gpt-6-luna' ||
          result.photoSent !== false || result.installable !== false ||
          !/^[a-f0-9]{32}$/.test(result.id) || !/^[a-f0-9]{64}$/.test(result.promptSha256) ||
          !['local-wink-review', 'local-head-tilt-review', 'unsupported-head-tilt-request', 'existing-video-review'].includes(result.route) ||
          result.plan?.version !== 1 || result.plan?.action !== actionCode ||
          !['subtle', 'standard', 'expressive'].includes(result.plan.motionIntensity) ||
          !Number.isInteger(result.plan.durationSeconds) || !Array.isArray(result.warnings) ||
          !['preparation', 'motion', 'settle', 'identityConstraint', 'reviewFocus'].every((key) =>
            typeof result.plan[key] === 'string' && result.plan[key].length > 0 && result.plan[key].length <= 240))
        throw new Error('模型返回的计划未通过结构与来源检查。');
      const allowedMultipliers = { subtle: 1.25, standard: 1.5, expressive: 1.75 };
      if (result.route === 'local-wink-review' &&
          (result.winkParameterSuggestion?.motionIntensity !== result.plan.motionIntensity ||
           result.winkParameterSuggestion?.drivingMultiplier !== allowedMultipliers[result.plan.motionIntensity]))
        throw new Error('眨眼参数建议与受限动作计划不一致。');
      aiPlanRecord = { id: result.id, promptSha256: result.promptSha256, model: result.model,
        motionIntensity: result.plan.motionIntensity, multiplier: result.winkParameterSuggestion?.drivingMultiplier,
        contextKey };
      byId('ai-plan-edit').value = `起势：${result.plan.preparation}\n主动作：${result.plan.motion}\n收势：${result.plan.settle}\n身份保护：${result.plan.identityConstraint}\n审核重点：${result.plan.reviewFocus}`.slice(0, 1200);
      byId('ai-plan-route').textContent = `约 ${result.plan.durationSeconds} 秒 · ${{'local-wink-review':'本机固定眨眼待审路线','local-head-tilt-review':'本机歪头模板：请在透明角色歪头区解释并应用 Prompt','unsupported-head-tilt-request':'当前歪头模板无法完整执行','existing-video-review':'已有视频待审路线'}[result.route]}。${result.warnings.join(' ')}`;
      byId('ai-plan-result').hidden = false;
      byId('ai-wink-apply').hidden = result.route !== 'local-wink-review';
      byId('ai-wink-apply').textContent = `应用${{ subtle: '轻微', standard: '标准', expressive: '明显' }[result.plan.motionIntensity]}眨眼幅度 ${result.winkParameterSuggestion?.drivingMultiplier?.toFixed(2) || ''}×`;
      status.textContent = 'AI 文字计划已生成，可编辑后用于角色描述；尚未生成动作素材。';
    } catch (error) {
      status.textContent = aiPlanController.signal.aborted ? '文字计划已取消；未应用任何结果。' :
        error.name === 'TimeoutError' ? '文字计划超时；未应用任何结果。' :
        error instanceof TypeError ? '无法连接本机文字计划服务；请先启动 tools/creative_plan_service.py。' :
        `文字计划失败：${error.message}`;
    } finally {
      aiPlanController = null;
      aiPlanRequestId = '';
      aiPlanBusy = false;
      byId('ai-plan-run').textContent = '生成文字计划';
      byId('ai-plan-run').disabled = !byId('ai-plan-consent').checked;
    }
  }
  function defaultWorkshopBackendNotice() {
    if (currentAction === '歪头看看') return '可在透明角色歪头制作区选择形体、幅度和时长；Prompt 作为记录保存，不会自动执行全部文字。新候选必须审核后才能安装。';
    if (currentAction !== '眨眨眼') return '当前动作还没有通用照片生成模板，可用已有视频制作待审候选；桌面继续保留已审核主题。';
    return sourceEvidence.includes('face')
      ? '可从当前照片本机试做眨眼，或使用已有动作视频。生成的视频带背景；透明边缘与身份仍要审核，桌面继续使用静态照片回退。'
      : '脸部可见范围尚未确认，本机照片眨眼路线暂停。仍可使用已有视频制作待审候选；桌面继续使用静态照片回退。';
  }
  function setSourceEvidence(value) {
    invalidateAiPlan();
    sourceEvidence = normalizeSourceEvidence(value, photoSource);
    document.querySelectorAll('[data-evidence-part]').forEach((input) => {
      input.checked = sourceEvidence.includes(input.dataset.evidencePart);
      if (input.dataset.evidencePart === 'fullSilhouette') input.disabled = !primaryDiffersFromBundledCrop();
    });
    const claim = sourceEvidence.includes('fullSilhouette') && primaryDiffersFromBundledCrop();
    byId('source-evidence-note').textContent = primaryIsBundledCrop()
      ? '这张样例的身体右侧被裁切，尾巴和后爪不可验证；完整轮廓不能标记为已拍到。'
      : claim
      ? `已记录完整轮廓由你确认（${1 + referencePhotos.length} 张照片）；仍需逐帧审查身份、解剖和边缘。`
      : `完整轮廓尚未得到照片确认（${1 + referencePhotos.length} 张照片）；未拍到的部位必须标为推断并单独审核。`;
    byId('plan-description').textContent = claim
      ? '照片轮廓由你确认 · 动作与透明边缘仍待审'
      : '照片未证实全身 · 全身候选需标为推断版本';
    renderPhotoCoverageNotice();
    renderActionSuitability();
    refreshPromptPlanPreview();
  }
  function newCharacterId() {
    return globalThis.crypto?.randomUUID?.() || `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  function normalizeRoleCandidate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-f0-9]{32}$/.test(value.id) ||
      !Number.isInteger(value.fps) || value.fps < 1 || value.fps > 30 ||
      !Number.isInteger(value.frameCount) || value.frameCount < 2 || value.frameCount > 120 ||
      !['眨眨眼', '歪头看看', '打个招呼'].includes(value.action)) return null;
    return { id: value.id, fps: value.fps, frameCount: value.frameCount, action: value.action };
  }
  function normalizeCharacter(profile, fallbackId = '') {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    const rawCreatedAt = typeof profile.createdAt === 'string' ? profile.createdAt : '';
    const action = ['眨眨眼', '歪头看看', '打个招呼'].includes(profile.action) ? profile.action : '眨眨眼';
    const reviewCandidate = normalizeRoleCandidate(profile.reviewCandidate);
    return {
      id: typeof profile.id === 'string' && /^[a-z0-9-]{4,80}$/i.test(profile.id) ? profile.id : fallbackId || `legacy-${rawCreatedAt.replace(/\D/g, '').slice(0, 16) || 'local'}`,
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim().slice(0, 18) : '小伙伴',
      mode: ['real', 'original'].includes(profile.mode) ? profile.mode : 'real',
      photo: isLocalPhoto(profile.photo) ? profile.photo : fallbackPhoto,
      photoName: typeof profile.photoName === 'string' ? profile.photoName.slice(0, 180) : '本地参考照片',
      referencePhotos: normalizeReferencePhotos(profile.referencePhotos),
      action,
      prompt: typeof profile.prompt === 'string' ? profile.prompt.slice(0, 1200) : '',
      traits: normalizeTraits(profile.traits),
      sourceEvidence: normalizeSourceEvidence(profile.sourceEvidence, profile.photo, normalizeReferencePhotos(profile.referencePhotos)),
      photoReview: normalizePhotoReview(profile.photoReview),
      reviewCandidate: reviewCandidate?.action === action ? reviewCandidate : null,
      previousVersion: normalizeRoleVersion(profile.previousVersion),
      versionHistory: normalizeRoleHistory(profile.versionHistory),
      photoStored: profile.photoStored === true,
      referencePhotoNames: Array.isArray(profile.referencePhotoNames)
        ? profile.referencePhotoNames.filter((name) => typeof name === 'string').slice(0, 3).map((name) => name.slice(0, 180)) : [],
      createdAt: rawCreatedAt || new Date().toISOString(),
      updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : rawCreatedAt || new Date().toISOString(),
    };
  }
  function editableSnapshot(profile) {
    if (!profile) return '';
    return JSON.stringify({ name: profile.name, mode: profile.mode, photo: profile.photo, photoName: profile.photoName, referencePhotos: normalizeReferencePhotos(profile.referencePhotos), action: profile.action, prompt: profile.prompt, traits: normalizeTraits(profile.traits), sourceEvidence: normalizeSourceEvidence(profile.sourceEvidence, profile.photo, normalizeReferencePhotos(profile.referencePhotos)), photoReview: normalizePhotoReview(profile.photoReview), reviewCandidate: normalizeRoleCandidate(profile.reviewCandidate) });
  }
  function normalizeRoleVersion(version) {
    if (!version || typeof version !== 'object' || Array.isArray(version) || typeof version.name !== 'string' || !version.name.trim() ||
      !['real', 'original'].includes(version.mode) || !isLocalPhoto(version.photo) || typeof version.photoName !== 'string' ||
      typeof version.prompt !== 'string' || !['眨眨眼', '歪头看看', '打个招呼'].includes(version.action)) return null;
    return { name: version.name.trim().slice(0, 18), mode: version.mode, photo: version.photo,
      photoName: version.photoName.slice(0, 180), action: version.action, prompt: version.prompt.slice(0, 1200),
      referencePhotos: normalizeReferencePhotos(version.referencePhotos),
      traits: normalizeTraits(version.traits), reviewCandidate: version.reviewCandidate?.action === version.action ? normalizeRoleCandidate(version.reviewCandidate) : null,
      sourceEvidence: normalizeSourceEvidence(version.sourceEvidence, version.photo, normalizeReferencePhotos(version.referencePhotos)),
      photoReview: normalizePhotoReview(version.photoReview),
      updatedAt: typeof version.updatedAt === 'string' ? version.updatedAt : '' };
  }
  function roleVersion(profile) {
    return normalizeRoleVersion({ name: profile.name, mode: profile.mode, photo: profile.photo, photoName: profile.photoName,
      referencePhotos: profile.referencePhotos, action: profile.action, prompt: profile.prompt, traits: profile.traits, sourceEvidence: profile.sourceEvidence,
      reviewCandidate: profile.reviewCandidate, photoReview: profile.photoReview, updatedAt: profile.updatedAt });
  }
  function normalizeRoleHistory(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, maxRoleVersions).filter((entry) => entry && typeof entry === 'object' &&
      /^[a-f0-9]{32}$/.test(entry.id) && typeof entry.name === 'string' && entry.name.trim() &&
      ['眨眨眼', '歪头看看', '打个招呼'].includes(entry.action))
      .map((entry) => ({ id: entry.id, name: entry.name.slice(0, 18), mode: ['real', 'original'].includes(entry.mode) ? entry.mode : 'real',
        action: entry.action, photoName: typeof entry.photoName === 'string' ? entry.photoName.slice(0, 180) : '本地参考照片',
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '' }));
  }
  let roleHistoryDbPromise;
  function openRoleHistoryDb() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('当前浏览器不支持本机版本库'));
    if (!roleHistoryDbPromise) roleHistoryDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('little-orbit-role-history', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('versions')) {
          const store = db.createObjectStore('versions', { keyPath: 'id' });
          store.createIndex('characterId', 'characterId', { unique: false });
        }
        if (!db.objectStoreNames.contains('characters')) db.createObjectStore('characters', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本机版本库'));
      request.onblocked = () => reject(new Error('本机版本库正被另一个工作室标签占用，请关闭重复标签后重试'));
    }).catch((error) => { roleHistoryDbPromise = null; throw error; });
    return roleHistoryDbPromise;
  }
  async function storeRoleVersion(characterId, version) {
    const snapshot = normalizeRoleVersion(version);
    if (!snapshot) throw new Error('角色版本内容无效');
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const db = await openRoleHistoryDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('versions', 'readwrite');
      tx.objectStore('versions').add({ id, characterId, version: snapshot });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('无法保存角色版本'));
      tx.onabort = () => reject(tx.error || new Error('角色版本保存已取消'));
    });
    return { id, name: snapshot.name, mode: snapshot.mode, action: snapshot.action,
      photoName: snapshot.photoName, updatedAt: snapshot.updatedAt || new Date().toISOString() };
  }
  function comparableRoleVersion(version) {
    const normalized = normalizeRoleVersion(version);
    if (!normalized) return '';
    return JSON.stringify({ ...normalized, updatedAt: '' });
  }
  async function archiveUniqueRoleVersion(characterId, version, history) {
    const key = comparableRoleVersion(version);
    for (const entry of normalizeRoleHistory(history)) {
      const saved = await readRoleVersion(entry.id, characterId);
      if (saved && comparableRoleVersion(saved) === key) return { entry, created: false };
    }
    return { entry: await storeRoleVersion(characterId, version), created: true };
  }
  async function compactRoleHistory(characterId, history) {
    const unique = [];
    const removed = [];
    const seen = new Set();
    for (const entry of normalizeRoleHistory(history)) {
      const snapshot = await readRoleVersion(entry.id, characterId);
      const key = comparableRoleVersion(snapshot);
      if (!key || seen.has(key)) { removed.push(entry.id); continue; }
      seen.add(key);
      unique.push(entry);
    }
    return { history: unique, removed };
  }
  async function readRoleVersion(id, characterId) {
    const db = await openRoleHistoryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('versions', 'readonly');
      const request = tx.objectStore('versions').get(id);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result?.characterId === characterId ? normalizeRoleVersion(result.version) : null);
      };
      request.onerror = () => reject(request.error || new Error('无法读取角色版本'));
    });
  }
  async function deleteRoleVersions(ids) {
    if (!ids.length) return;
    const db = await openRoleHistoryDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('versions', 'readwrite');
      const store = tx.objectStore('versions');
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('无法清理已淘汰的角色版本'));
      tx.onabort = () => reject(tx.error || new Error('版本清理已取消'));
    });
  }
  function characterIndex(profile) {
    const photosAreStored = profile.photoStored === true;
    return normalizeCharacter({ ...profile, photo: photosAreStored ? fallbackPhoto : profile.photo,
      referencePhotos: photosAreStored ? [] : profile.referencePhotos, photoStored: photosAreStored,
      referencePhotoNames: photosAreStored ? normalizeReferencePhotos(profile.referencePhotos).map((item) => item.photoName) : [] });
  }
  function serializeCharacterIndex(profiles) {
    return JSON.stringify(profiles.map((profile) => characterIndex(profile)));
  }
  async function readStoredCharacter(id) {
    const db = await openRoleHistoryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readonly');
      const request = tx.objectStore('characters').get(id);
      request.onsuccess = () => resolve(request.result?.profile || null);
      request.onerror = () => reject(request.error || new Error('无法读取本地角色照片'));
    });
  }
  async function writeStoredCharacter(profile) {
    const db = await openRoleHistoryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readwrite');
      tx.objectStore('characters').put({ id: profile.id, profile: { ...profile, photoStored: false, referencePhotoNames: [] } });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('无法保存角色照片到本机数据库'));
      tx.onabort = () => reject(tx.error || new Error('角色照片保存已取消'));
    });
  }
  async function deleteStoredCharacter(id) {
    const db = await openRoleHistoryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readwrite');
      tx.objectStore('characters').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('无法清理本地角色照片'));
    });
  }
  async function hydrateSavedCharacters() {
    const hydrated = [];
    let indexChanged = false;
    for (const indexed of savedCharacters) {
      try {
        const stored = indexed.photoStored ? await readStoredCharacter(indexed.id) : null;
        let profile;
        if (stored && isLocalPhoto(stored.photo)) {
          profile = normalizeCharacter({ ...stored, ...indexed, photo: stored.photo,
            referencePhotos: normalizeReferencePhotos(stored.referencePhotos) });
        } else if (indexed.photoStored) {
          profile = indexed;
          tell(`角色「${indexed.name}」的本机照片记录缺失，角色卡仍保留；请重新导入照片或从备份恢复。`);
        } else if (!indexed.photoStored && isLocalPhoto(indexed.photo)) {
          await writeStoredCharacter(indexed);
          profile = normalizeCharacter({ ...indexed, photoStored: true });
          indexChanged = true;
        } else {
          profile = indexed;
        }
        if (profile.previousVersion) {
          const compacted = await compactRoleHistory(profile.id, profile.versionHistory);
          const migrated = await archiveUniqueRoleVersion(profile.id, profile.previousVersion, compacted.history);
          let history = [migrated.entry, ...compacted.history.filter((entry) => entry.id !== migrated.entry.id)];
          const removed = [...compacted.removed];
          if (history.length > maxRoleVersions) {
            removed.push(...history.slice(maxRoleVersions).map((entry) => entry.id));
            history = history.slice(0, maxRoleVersions);
          }
          if (removed.length) await deleteRoleVersions(removed).catch(() => {});
          profile = normalizeCharacter({ ...profile, previousVersion: null, versionHistory: history });
          indexChanged = true;
        }
        hydrated.push(profile);
      } catch (error) {
        hydrated.push(indexed);
        tell(`角色「${indexed.name}」的本地照片暂时无法读取：${error.message}`);
      }
    }
    savedCharacters = hydrated;
    if (indexChanged || savedCharacters.some((profile) => !profile.photoStored)) {
      try {
        localStorage.setItem('littleOrbit.characters', serializeCharacterIndex(savedCharacters));
        localStorage.removeItem('littleOrbit.character');
      } catch { tell('角色照片已迁入本机数据库，但本地角色摘要尚未完成整理。'); }
    }
  }
  let preferences = { interactionEnabled: true, automaticActionsEnabled: false, quietEnabled: false,
    quietStart: '22:00', quietEnd: '08:00', frequencyMinutes: 15 };
  try { preferences = { ...preferences, ...JSON.parse(localStorage.getItem('littleOrbit.preferences') || '{}') }; }
  catch { /* Use quiet local defaults when storage is unavailable. */ }
  if (typeof preferences.automaticActionsEnabled !== 'boolean') preferences.automaticActionsEnabled = false;

  try {
    const storedCharacters = JSON.parse(localStorage.getItem('littleOrbit.characters') || 'null');
    if (Array.isArray(storedCharacters)) {
      savedCharacters = storedCharacters.map((profile) => normalizeCharacter(profile)).filter(Boolean);
      const unique = new Set();
      savedCharacters = savedCharacters.filter((profile) => !unique.has(profile.id) && unique.add(profile.id));
    } else {
      const legacy = JSON.parse(localStorage.getItem('littleOrbit.character') || 'null');
      const migrated = normalizeCharacter(legacy);
      if (migrated) {
        savedCharacters = [migrated];
      }
    }
    await hydrateSavedCharacters();
    const activeId = localStorage.getItem('littleOrbit.activeCharacterId');
    savedCharacter = savedCharacters.find((profile) => profile.id === activeId) || savedCharacters[0] || null;
    const draft = JSON.parse(localStorage.getItem('littleOrbit.draft') || 'null');
    const hasDraft = draft && typeof draft === 'object';
    const draftId = localStorage.getItem('littleOrbit.draftCharacterId');
    editingCharacterId = hasDraft ? (savedCharacters.some((profile) => profile.id === draftId) ? draftId : null) : savedCharacter?.id || null;
    const initial = hasDraft ? draft : savedCharacter;
    if (initial) {
      ui.name.value = typeof initial.name === 'string' ? initial.name.slice(0, 18) : '橘子';
      mode = ['real', 'original'].includes(initial.mode) ? initial.mode : 'real';
      photoSource = isLocalPhoto(initial.photo) ? initial.photo : fallbackPhoto;
      photoName = typeof initial.photoName === 'string' ? initial.photoName.slice(0, 180) : photoName;
      referencePhotos = normalizeReferencePhotos(initial.referencePhotos);
      renderReferencePhotos();
      setPhotoReview(initial.photoReview);
      setSourceEvidence(initial.sourceEvidence);
      currentAction = ['眨眨眼', '歪头看看', '打个招呼'].includes(initial.action) ? initial.action : currentAction;
      activeReviewCandidate = normalizeRoleCandidate(initial.reviewCandidate);
      byId('prompt-input').value = typeof initial.prompt === 'string' ? initial.prompt.slice(0, 1200) : byId('prompt-input').value;
      const draftBase = savedCharacters.find((profile) => profile.id === editingCharacterId);
      updateImages(photoSource);
      setMode(mode, false);
      setAction(currentAction, false);
      if (Array.isArray(initial.traits)) {
        const initialTraits = normalizeTraits(initial.traits);
        document.querySelectorAll('.trait-list label').forEach((label) => {
          label.querySelector('input').checked = initialTraits.includes(traitLabelText(label));
        });
      }
      setPetTitle(draftBase?.name || savedCharacter?.name || '小伙伴');
    }
    updateCharacterCount();
  } catch { /* Corrupt or unavailable local storage should never block creating a new preview. */ }
  renderReferencePhotos();
  renderCharacterLibrary();

  function tell(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }
  function updateImages(src) {
    if (headTiltPhotoSource && headTiltPhotoSource !== src) {
      byId('head-tilt-candidates')?.querySelectorAll('[data-candidate-id]').forEach(card=>card._releaseFrame?.());
      byId('head-tilt-candidates')?.replaceChildren();
      if (byId('head-tilt-confirm')) byId('head-tilt-confirm').checked = false;
      if (byId('head-tilt-status')) byId('head-tilt-status').textContent = '照片已更换，旧歪头候选已从当前角色移出；制作记录仍保留在本机。';
      headTiltPhotoSource = null;
    }
    renderWanHistory();
    if (wanAnchorPhoto && wanAnchorPhoto !== src) {
      byId('wan-anchor-file').value = '';
      byId('wan-anchor-review').hidden = true;
      byId('wan-anchor-confirm').checked = false;
      byId('wan-anchor-confirm').disabled = true;
      byId('wan-anchor-source-note').textContent = '主照片已更换；请为当前照片重新准备透明锚图并检查三背景预览。';
      byId('wan-source-coverage').value = '';
      wanAnchorPhoto = null;
    }
    if (wanCandidate && wanCandidate.photo !== src) {
      wanCandidate = null;
      byId('wan-result').hidden = true;
      byId('wan-use').disabled = true;
      byId('wan-status').textContent = '参考照片已改变；请重新生成视频候选。';
    }
    if (photoWinkCandidate && photoWinkCandidate.photo !== src) {
      photoWinkCandidate = null;
      byId('photo-wink-result').hidden = true;
      byId('photo-wink-video').removeAttribute('src');
      byId('photo-wink-video').load();
      byId('photo-wink-status').textContent = '照片已更新；请为当前角色重新生成动作预览。';
    }
    if (segmentationPreviewPhoto && segmentationPreviewPhoto !== src) {
      clearPortraitFraming();
      segmentationPreviewPhoto = null;
      byId('segmentation-result').hidden = true;
      byId('segmentation-editor').hidden = true;
      byId('segmentation-edit-toggle').setAttribute('aria-expanded', 'false');
      segmentationEditor.canvas = null;
      segmentationEditor.originalPixels = null;
      segmentationEditor.sourcePixels = null;
      segmentationEditor.sourceImage = null;
      segmentationEditor.edgeReview = null;
      segmentationEditor.regionReview = null;
      segmentationEditor.promptReview = null;
      segmentationEditor.undo = [];
      segmentationEditor.changed = false;
      byId('segmentation-status').textContent = '照片已更新。启动所选的本机分割服务后可重新生成候选。';
    }
    sam2PromptState.foreground = [];
    sam2PromptState.background = [];
    sam2PromptState.photo = src;
    [ui.photo, ui.dialogImage, ui.workshopImage, ui.petImage].forEach((img) => { if (img) img.src = src; });
    void refreshBundledCopyStatus(src);
    if (byId('sam2-canvas')) renderSam2PromptCanvas();
    if (portraitHistoryLoaded) syncPortraitHistory(src);
  }
  function setWorkshopPreviewName(name) {
    const previewName = name || '小伙伴';
    ui.workshopImage.alt = `${previewName}的桌面预览`;
    document.querySelectorAll('.preview-caption').forEach((caption) => { caption.firstChild.textContent = previewName; });
  }
  function roleVideoContextIsCurrent() {
    return !roleVideoContext || (roleVideoContext.photo === photoSource && roleVideoContext.action === currentAction &&
      roleVideoContext.mode === mode && roleVideoContext.name === (ui.name.value.trim() || '小伙伴') &&
      roleVideoContext.sourceEvidence === JSON.stringify(sourceEvidence) &&
      (!Array.isArray(roleVideoContext.traits) || JSON.stringify(roleVideoContext.traits) === JSON.stringify(normalizeTraits([...document.querySelectorAll('.trait-list input:checked')].map((input) => traitLabelText(input.parentElement))))) &&
      roleVideoContext.photoReview === JSON.stringify(photoReview) &&
      roleVideoContext.prompt === byId('prompt-input').value.trim());
  }
  function renderRoleVideoContext() {
    const panel = byId('sam2-video-role-context');
    panel.hidden = !roleVideoContext;
    if (roleVideoContext) {
      byId('sam2-video-role-photo').src = roleVideoContext.photo;
      byId('sam2-video-role-title').textContent = `${roleVideoContext.name} · 计划动作「${roleVideoContext.action}」${roleVideoContext.sourceCandidate ? ` · ${roleVideoContext.sourceCandidate.model} ${roleVideoContext.sourceCandidate.id.slice(0, 8)}` : ''}`;
      byId('sam2-video-role-prompt').textContent = roleVideoContext.prompt || '尚未填写动作描述；请对照角色照片核对视频。';
    } else {
      byId('sam2-video-role-confirm').checked = false;
      byId('sam2-video-role-photo').removeAttribute('src');
    }
    renderSam2VideoPromptCanvas();
    const selected = sam2VideoState.history.find((item) => item.id === sam2VideoState.selectedCandidateId &&
      item.sourceKey === sam2VideoState.sourceKey);
    if (selected) displayVideoCandidate(selected);
  }
  function renderWorkshopCandidate() {
    const candidate = normalizeRoleCandidate(activeReviewCandidate);
    const panel = byId('workshop-candidate-review');
    const image = byId('workshop-candidate-image');
    byId('workshop-preview').classList.toggle('has-candidate', !!candidate);
    panel.hidden = !candidate;
    image.hidden = !candidate;
    byId('plan-status').textContent = candidate ? '候选待审' : '待生成';
    byId('request-generation').firstChild.textContent = candidate ? '保存待审记录，打开静态预览 ' : '保存角色卡，打开预览 ';
    byId('workshop-preview-status').textContent = candidate ? '190px 候选动画' : '静态照片预览';
    byId('workshop-preview-detail').textContent = candidate ? '未批准 · 未安装' : '还未生成动作';
    byId('backend-notice-text').textContent = candidate
      ? '这段视频已分割为待审候选，但尚未通过角色身份、动作、裁切与透明边缘检查。保存角色卡只记录候选；桌面仍使用静态照片回退。'
      : defaultWorkshopBackendNotice();
    if (!candidate) { image.removeAttribute('src'); image.onerror = null; return; }
    image.onerror = () => {
      if (activeReviewCandidate?.id === candidate.id) {
        byId('workshop-candidate-note').textContent = '本机候选文件不可用。请确认 SAM 2.1 服务正在运行，且工作区输出尚未被清理；此角色卡仍只保存待审编号。';
      }
    };
    image.src = videoReviewAsset(candidate.id, 'review-190px-loop.gif');
    byId('workshop-candidate-meta').textContent = `计划动作「${candidate.action}」· 是否相符待审核 · ${candidate.frameCount} 帧 @ ${candidate.fps} fps · 候选编号 ${candidate.id.slice(0, 8)} · 未安装`;
    byId('workshop-candidate-note').textContent = '对照上一步确认的角色照片，检查是否为同一只宠物、动作是否相符、裁切与透明边缘是否合格。保存角色卡不会安装或批准这段素材。';
    byId('workshop-candidate-edge').href = videoReviewAsset(candidate.id, 'review-190px-warm-blue.jpg');
  }
  function setPetTitle(name) {
    const title = byId('pet-title');
    title.childNodes[1].textContent = ` 桌面预览 · ${name}`;
    byId('pet-interact').firstChild.textContent = `和${name}互动 `;
    byId('pet-figure').setAttribute('aria-label', `点击${name}互动`);
    ui.petImage.alt = `${name}的桌面宠物静态预览`;
    setWorkshopPreviewName(name);
  }
  function imageFromSource(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法载入本机修整图像。'));
      image.src = source;
    });
  }
  async function renderSam2PromptCanvas() {
    const canvas = byId('sam2-canvas');
    if (!canvas) return;
    const source = selectedSegmentationSource().photo;
    try {
      const image = await imageFromSource(source);
      if (source !== selectedSegmentationSource().photo) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      for (const [label, color] of [['foreground', '#36a876'], ['background', '#db674e']]) {
        context.lineWidth = Math.max(3, canvas.width / 260);
        context.font = `bold ${Math.max(20, canvas.width / 28)}px sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        sam2PromptState[label].forEach(([x, y], index) => {
          const radius = Math.max(13, canvas.width / 72);
          context.fillStyle = `${color}df`;
          context.strokeStyle = '#fff';
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
          context.stroke();
          context.fillStyle = '#fff';
          context.fillText(label === 'foreground' ? '+' : '−', x, y - 1);
          context.font = `600 ${Math.max(12, canvas.width / 70)}px sans-serif`;
          context.fillText(String(index + 1), x + radius * 0.75, y - radius * 0.75);
          context.font = `bold ${Math.max(20, canvas.width / 28)}px sans-serif`;
        });
      }
      byId('sam2-point-count').textContent = `前景 ${sam2PromptState.foreground.length} · 背景 ${sam2PromptState.background.length}`;
    } catch (error) {
      byId('sam2-point-count').textContent = `参考图载入失败：${error.message}`;
    }
  }
  function updateSam2VideoFileInfo(message = '') {
    const fileInfo = byId('sam2-video-file-info');
    if (message) { fileInfo.textContent = message; return; }
    if (!sam2VideoState.file) { fileInfo.textContent = '支持 MP4 / WebM；最多 120 帧，画面完整适配为 512×512。'; return; }
    const frameCount = Math.round(sam2VideoState.duration * sam2VideoState.fps);
    const maxDuration = 120 / sam2VideoState.fps;
    const withinFrameLimit = frameCount >= 2 && frameCount <= 120;
    fileInfo.textContent = `${sam2VideoState.file.name} · ${sam2VideoState.width}×${sam2VideoState.height} · ${sam2VideoState.duration.toFixed(2)} 秒 · ${frameCount} 帧 @ ${sam2VideoState.fps} fps · 内容指纹 ${sam2VideoState.sourceKey.slice(0, 12)} · 上限 ${maxDuration.toFixed(1)} 秒${withinFrameLimit ? '' : ' · 请降低帧率或缩短视频'}`;
  }
  function drawLetterboxedVideoFrame(video, context) {
    const canvas = context.canvas;
    context.fillStyle = '#292824';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  }
  function renderSam2VideoPromptCanvas() {
    const canvas = byId('sam2-video-canvas');
    const video = byId('sam2-video-player');
    if (!canvas || !video.videoWidth) return;
    const context = canvas.getContext('2d');
    if (sam2VideoState.firstFrame) context.drawImage(sam2VideoState.firstFrame, 0, 0);
    else drawLetterboxedVideoFrame(video, context);
    for (const [label, points, color] of [
      ['foreground', sam2VideoState.foreground, '#36a876'],
      ['background', sam2VideoState.background, '#db674e'],
    ]) {
      points.forEach(([x, y], index) => {
        const radius = 12;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = `${color}e8`;
        context.strokeStyle = '#fff';
        context.lineWidth = 3;
        context.fill();
        context.stroke();
        context.font = 'bold 16px sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = '#fff';
        context.fillText(label === 'foreground' ? '+' : '−', x, y - 1);
        context.font = '600 10px sans-serif';
        context.fillText(String(index + 1), x + 9, y - 9);
      });
    }
    byId('sam2-video-point-count').textContent = `前景 ${sam2VideoState.foreground.length} · 背景 ${sam2VideoState.background.length}`;
    const frameCount = Math.round(sam2VideoState.duration * sam2VideoState.fps);
    byId('sam2-video-run').disabled = sam2VideoState.busy || !sam2VideoState.file || sam2VideoState.foreground.length === 0 || frameCount < 2 || frameCount > 120 ||
      !!roleVideoContext && (!roleVideoContextIsCurrent() || !byId('sam2-video-role-confirm').checked);
  }
  function waitForVideoEvent(video, eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error('视频读取超时。')), timeoutMs);
      const onEvent = () => finish();
      const onError = () => finish(new Error('浏览器无法解码这段视频。'));
      const finish = (error) => {
        window.clearTimeout(timeout);
        video.removeEventListener(eventName, onEvent);
        video.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      video.addEventListener(eventName, onEvent, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  }
  async function seekVideo(video, time) {
    if (Math.abs(video.currentTime - time) < 0.0005 && video.readyState >= 2) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return;
    }
    const seeked = waitForVideoEvent(video, 'seeked');
    video.currentTime = time;
    await seeked;
  }
  async function blobToBase64(blob) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('无法读取本机视频帧。'));
      reader.readAsDataURL(blob);
    });
    return String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
  }
  async function extractSam2VideoFrames(video, fps, expectedFile) {
    const count = Math.round(video.duration * fps);
    if (count < 2 || count > 120) throw new Error('动作片段帧数需要在 2 到 120 帧之间。');
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建本机帧采样画布。');
    const frames = [];
    let encodedBytes = 0;
    video.pause();
    try {
      for (let index = 0; index < count; index++) {
        if (sam2VideoState.file !== expectedFile) throw new Error('处理期间所选视频已更改，请重新选择。');
        await seekVideo(video, index / fps);
        drawLetterboxedVideoFrame(video, context);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
        if (!blob) throw new Error('无法编码本机视频帧。');
        if (blob.size > 400 * 1024) throw new Error('单帧画面超过本机服务的 400 KB 限制；请降低视频画质后重试。');
        encodedBytes += blob.size;
        if (encodedBytes > 22 * 1024 * 1024) throw new Error('抽取帧超过本机服务的安全上传限制；请降低帧率或缩短片段。');
        frames.push(await blobToBase64(blob));
        byId('sam2-video-status').textContent = `本机正在抽取视频帧 ${index + 1} / ${count}……视频和音轨尚未发送。`;
        if (index % 4 === 3) await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    } finally {
      try { await seekVideo(video, 0); } catch { /* Keep the original sampling error. */ }
    }
    return frames;
  }
  function assertLocalVideoReviewUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (url.origin !== 'http://127.0.0.1:4175' || !url.pathname.startsWith('/api/review/')) throw new Error('本机服务返回了非本机候选链接。');
    return url.href;
  }
  const videoHistoryKey = 'ai-pet-sam2-video-candidates-v2';
  const legacyVideoHistoryKey = 'ai-pet-sam2-video-candidates-v1';
  const videoHistoryLimit = 12;
  const videoVisualReviewChecks = ['identity', 'motion', 'anatomy', 'timing', 'edge'];
  const videoReviewIssues = {
    'identity': '身份或花纹不一致',
    'motion': '动作或循环不自然',
    'anatomy': '身体结构有误',
    'crop': '主体被裁切或遮挡',
    'edge': '透明边缘或背景残留',
  };
  const videoAlphaMappings = {
    'bounded-smoothstep-0.25': '有界 alpha v2',
    'legacy-sigmoid-0.75': '旧版柔化 alpha',
    'unknown': '蒙版版本未知',
  };
  function normalizeBorderContact(value, frameCount) {
    if (!value || typeof value !== 'object' || value.bandPx !== 5 || value.opaqueAlphaThreshold !== 128 ||
        value.minimumBandFraction !== 0.1 || !value.contactFrames || typeof value.contactFrames !== 'object') return null;
    const counts = value.contactFrames;
    if (['top', 'bottom', 'left', 'right'].some((side) =>
      !Number.isInteger(counts[side]) || counts[side] < 0 || counts[side] > frameCount)) return null;
    return { bandPx: 5, opaqueAlphaThreshold: 128, minimumBandFraction: 0.1,
      contactFrames: { top: counts.top, bottom: counts.bottom, left: counts.left, right: counts.right } };
  }
  function normalizeReviewSampling(value, frameCount) {
    if (!value || typeof value !== 'object' || value.method !== 'timeline-plus-worst-mask-jump-border-contact-area-change' ||
        !Array.isArray(value.frames) || value.frames.length < 2 || value.frames.length > 12 ||
        value.frames[0] !== 1 || value.frames.at(-1) !== frameCount ||
        value.frames.some((frame, index) => !Number.isInteger(frame) || frame < 1 || frame > frameCount ||
          index > 0 && frame <= value.frames[index - 1]) ||
        !value.worstFrames || typeof value.worstFrames !== 'object' ||
        ['maskJump', 'borderContact', 'areaChange'].some((key) =>
          !Number.isInteger(value.worstFrames[key]) || !value.frames.includes(value.worstFrames[key]))) return null;
    return { method: value.method, frames: [...value.frames], worstFrames: {
      maskJump: value.worstFrames.maskJump, borderContact: value.worstFrames.borderContact,
      areaChange: value.worstFrames.areaChange } };
  }
  function normalizeVideoPlanSnapshot(value) {
    const sourceCandidate = value?.sourceCandidate == null ? null : value.sourceCandidate;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !['real', 'original'].includes(value.mode) ||
        !['眨眨眼', '歪头看看', '打个招呼'].includes(value.action) ||
        typeof value.name !== 'string' || value.name.length > 180 ||
        typeof value.prompt !== 'string' || value.prompt.length > 1200 ||
        typeof value.photoKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.photoKey) ||
        value.traits !== undefined && (!Array.isArray(value.traits) || value.traits.length > 12 || value.traits.some((trait) => !knownTraits.includes(trait))) ||
        typeof value.sourceEvidence !== 'string' || value.sourceEvidence.length > 256 ||
        typeof value.photoReview !== 'string' || value.photoReview.length > 128 ||
        sourceCandidate && (typeof sourceCandidate !== 'object' || Array.isArray(sourceCandidate) ||
          Object.keys(sourceCandidate).sort().join(',') !== 'composition,id,model' ||
          !/^[a-f0-9]{32}$/.test(sourceCandidate.id) ||
          !['face-crop', 'full-image-pasteback', 'rgba-anchor-i2v'].includes(sourceCandidate.composition) ||
          (sourceCandidate.composition === 'rgba-anchor-i2v'
            ? sourceCandidate.model !== 'Wan 2.2 TI2V-5B fp16'
            : sourceCandidate.model !== 'LivePortrait Animals v1.1'))) return null;
    try {
      const evidence = JSON.parse(value.sourceEvidence);
      const review = JSON.parse(value.photoReview);
      if (!Array.isArray(evidence) || evidence.some((item) => !evidenceParts.includes(item)) ||
          !review || typeof review !== 'object' ||
          !['one', 'multiple', 'uncertain'].includes(review.subjectCount) ||
          !['clear', 'present', 'uncertain'].includes(review.occlusion)) return null;
    } catch { return null; }
    return { mode: value.mode, action: value.action, name: value.name,
      prompt: value.prompt, photoKey: value.photoKey,
      traits: Array.isArray(value.traits) ? [...value.traits] : null,
      sourceEvidence: value.sourceEvidence, photoReview: value.photoReview,
      sourceCandidate: sourceCandidate ? { id: sourceCandidate.id, composition: sourceCandidate.composition,
        model: sourceCandidate.model } : null };
  }
  function videoPlanSnapshotMatchesContext(snapshot, context) {
    const normalized = normalizeVideoPlanSnapshot(snapshot);
    return !!normalized && !!context && normalized.mode === context.mode &&
      normalized.action === context.action && normalized.name === context.name &&
      normalized.prompt === context.prompt && normalized.sourceEvidence === context.sourceEvidence &&
      normalized.photoReview === context.photoReview && normalized.photoKey === context.photoKey &&
      (!normalized.traits || JSON.stringify(normalized.traits) === JSON.stringify(context.traits)) &&
      JSON.stringify(normalized.sourceCandidate) === JSON.stringify(context.sourceCandidate || null);
  }
  function reviewFocusNote(candidate) {
    const worst = candidate.reviewSampling?.worstFrames;
    if (!worst) return '重点帧未记录';
    const focus = new Map();
    for (const [key, label] of [['borderContact', '边缘'], ['maskJump', '蒙版跳变'], ['areaChange', '面积变化']]) {
      const frame = worst[key];
      focus.set(frame, focus.has(frame) ? `${focus.get(frame)}、${label}` : label);
    }
    return `重点核对 ${[...focus].map(([frame, reason]) => `第 ${frame} 帧${reason}`).join('；')}`;
  }
  function borderContactNote(candidate) {
    if (!candidate.borderContact) return '画框接触未记录';
    const labels = { top: '上边', bottom: '下边', left: '左边', right: '右边' };
    const persistent = Object.entries(labels).filter(([side]) =>
      candidate.borderContact.contactFrames[side] >= Math.ceil(candidate.frameCount * 0.8));
    return persistent.length
      ? `画框接触：${persistent.map(([side, label]) => `${label} ${candidate.borderContact.contactFrames[side]}/${candidate.frameCount} 帧`).join('、')}；检查裁切或背景粘连`
      : '未发现持续画框接触';
  }
  function candidateReviewIssue(id) {
    return sam2VideoState.history.find((item) => item.id === id)?.reviewIssue || '';
  }
  function legacyVideoSourceKey(file) {
    return `${file.name.slice(0, 160)}\u001f${file.size}\u001f${file.lastModified}`;
  }
  function legacyVideoMatches(file) {
    try {
      const records = JSON.parse(localStorage.getItem(legacyVideoHistoryKey) || '[]');
      return Array.isArray(records) && records.some((item) => item?.sourceKey === legacyVideoSourceKey(file));
    } catch { return false; }
  }
  async function localSha256(blob) {
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async function videoSourceKey(file) {
    return localSha256(file);
  }
  function videoReviewAsset(candidateId, filename) {
    if (!/^[a-f0-9]{32}$/.test(candidateId)) throw new Error('候选编号无效。');
    return `http://127.0.0.1:4175/api/review/${candidateId}/${filename}`;
  }
  function portraitReviewAsset(candidateId, filename) {
    if (!/^[a-f0-9]{32}$/.test(candidateId) || !['clip.mp4', 'review-190px.jpg'].includes(filename)) throw new Error('动作候选链接无效。');
    return `http://127.0.0.1:4176/api/review/${candidateId}/${filename}`;
  }
  function normalizePortraitCandidate(value) {
    const planTrace = value?.planTrace == null ? null : value.planTrace;
    const traceMultipliers = { subtle: 1.25, standard: 1.5, expressive: 1.75 };
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !/^[a-f0-9]{32}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.photoKey) ||
        value.action !== 'wink' || !Number.isInteger(value.frameCount) || value.frameCount < 2 || value.frameCount > 120 ||
        (value.landmarkRoute !== undefined && !['manual-nine-point', 'xpose-research'].includes(value.landmarkRoute)) ||
        (value.composition !== undefined && !['face-crop', 'full-image-pasteback'].includes(value.composition)) ||
        value.fps !== 25 || !Number.isFinite(value.generationSeconds) || value.generationSeconds <= 0 || value.generationSeconds > 180 ||
        typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
        (value.drivingMultiplier !== undefined && (!Number.isFinite(value.drivingMultiplier) || value.drivingMultiplier < 0.5 || value.drivingMultiplier > 2)) ||
        (value.sourceScale !== undefined && (!Number.isFinite(value.sourceScale) || value.sourceScale < 2.3 || value.sourceScale > 3.2 || Math.abs(value.sourceScale * 10 - Math.round(value.sourceScale * 10)) > 1e-6)) ||
        (value.sourceCrop !== undefined && (!Array.isArray(value.sourceCrop) || value.sourceCrop.length !== 4 || value.sourceCrop.some((n) => !Number.isInteger(n) || n < 0) ||
          !Array.isArray(value.sourceSize) || value.sourceSize.length !== 2 || value.sourceSize.some((n) => !Number.isInteger(n) || n < 256 || n > 10000) ||
          value.sourceCrop[0] >= value.sourceCrop[2] || value.sourceCrop[1] >= value.sourceCrop[3] ||
          value.sourceCrop[2] > value.sourceSize[0] || value.sourceCrop[3] > value.sourceSize[1])) ||
        (planTrace && (typeof planTrace !== 'object' || Array.isArray(planTrace) ||
          Object.keys(planTrace).sort().join(',') !== 'model,motionIntensity,planId,promptSha256' ||
          !/^[a-f0-9]{32}$/.test(planTrace.planId) || !/^[a-f0-9]{64}$/.test(planTrace.promptSha256) ||
          planTrace.model !== 'gpt-6-luna' || !Object.hasOwn(traceMultipliers, planTrace.motionIntensity) ||
          traceMultipliers[planTrace.motionIntensity] !== value.drivingMultiplier))) return null;
    const drivingMultiplier = Number.isFinite(value.drivingMultiplier) ? value.drivingMultiplier : legacyWinkMultipliers[value.winkStrength] || 1.75;
    const sourceScale = Number.isFinite(value.sourceScale) ? value.sourceScale : 2.3;
    return { id: value.id, photoKey: value.photoKey, action: 'wink', frameCount: value.frameCount,
      fps: 25, drivingMultiplier, sourceScale, composition: value.composition || 'face-crop',
      landmarkRoute: value.landmarkRoute || 'xpose-research',
      generationSeconds: value.generationSeconds, createdAt: value.createdAt, planTrace,
      ...(value.sourceCrop ? { sourceCrop: value.sourceCrop, sourceSize: value.sourceSize } : {}) };
  }
  function loadPortraitHistory() {
    try {
      const values = JSON.parse(localStorage.getItem(portraitHistoryKey) || '[]');
      if (!Array.isArray(values)) return [];
      const seen = new Set();
      return values.map(normalizePortraitCandidate).filter((item) => item && !seen.has(item.id) && seen.add(item.id)).slice(0, 12);
    } catch { return []; }
  }
  async function portraitPhotoFingerprint(blob) {
    return localSha256(blob);
  }
  async function portraitPhotoSourceBlob(source) {
    if (typeof source === 'string' && source.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source);
      if (!match || source.length > 11_200_000) throw new Error('当前本机照片格式或大小无效。');
      const binary = atob(match[2]);
      const chunks = [];
      for (let offset = 0; offset < binary.length; offset += 65536) {
        const segment = binary.slice(offset, offset + 65536);
        const bytes = new Uint8Array(segment.length);
        for (let index = 0; index < segment.length; index++) bytes[index] = segment.charCodeAt(index);
        chunks.push(bytes);
      }
      return new Blob(chunks, { type: match[1] });
    }
    const response = await fetch(source);
    if (!response.ok) throw new Error('无法读取当前本机照片。');
    return response.blob();
  }
  function renderPortraitHistory() {
    const panel = byId('photo-wink-history');
    const grid = byId('photo-wink-history-grid');
    grid.replaceChildren();
    const values = currentAction === '眨眨眼' && portraitPhotoKey
      ? portraitHistory.filter((item) => [portraitPhotoKey, portraitLegacyPhotoKey].includes(item.photoKey) &&
          (item.landmarkRoute === 'manual-nine-point' || xposeResearchConsent)).slice(0, 4) : [];
    panel.hidden = values.length === 0;
    byId('photo-wink-history-count').textContent = `${values.length} 个候选`;
    for (const item of values) {
      const card = document.createElement('article');
      card.className = `photo-motion-history-card${photoWinkCandidate?.candidateId === item.id ? ' selected' : ''}`;
      const image = document.createElement('img');
      image.src = portraitReviewAsset(item.id, 'review-190px.jpg');
      image.alt = `眨眼候选 ${item.id.slice(0, 8)} 的 190px 审核图`;
      image.loading = 'lazy';
      const details = document.createElement('span');
      details.textContent = `${item.landmarkRoute === 'manual-nine-point' ? '手工九点' : 'X-Pose 科研'} · 幅度 ${item.drivingMultiplier.toFixed(2)}× · ${item.sourceCrop ? '蒙版主体取景' : item.composition === 'full-image-pasteback' ? '完整照片' : '脸部取景'} · 取景 ${item.sourceScale.toFixed(1)}× · ${item.frameCount} 帧 · ${item.fps} fps · ${item.planTrace ? `AI 计划 ${item.planTrace.planId.slice(0, 8)} · ` : ''}${new Date(item.createdAt).toLocaleString('zh-CN')} · ${item.id.slice(0, 8)}`;
      const button = document.createElement('button');
      button.className = 'secondary-button';
      button.type = 'button';
      button.textContent = photoWinkCandidate?.candidateId === item.id ? '正在上方查看' : '查看此候选';
      button.disabled = (item.landmarkRoute !== 'manual-nine-point' && !xposeResearchConsent) || photoWinkCandidate?.candidateId === item.id;
      button.addEventListener('click', () => restorePortraitCandidate(item));
      card.append(image, details, button);
      grid.append(card);
    }
  }
  async function syncPortraitHistory(src) {
    const revision = ++portraitKeyRevision;
    portraitPhotoKey = '';
    portraitLegacyPhotoKey = '';
    renderPortraitHistory();
    try {
      const blob = await portraitPhotoSourceBlob(src);
      const key = await portraitPhotoFingerprint(blob);
      let legacyKey = '';
      if (portraitHistory.some((item) => item.photoKey !== key)) {
        const image = await imageFromSource(src);
        const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const legacyBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
        if (legacyBlob) legacyKey = await portraitPhotoFingerprint(legacyBlob);
      }
      if (revision !== portraitKeyRevision || src !== photoSource) return;
      portraitPhotoKey = key;
      portraitLegacyPhotoKey = legacyKey;
      renderPortraitHistory();
    } catch {
      if (revision === portraitKeyRevision) renderPortraitHistory();
    }
  }
  function showPortraitCandidate(item, photo) {
    byId('photo-wink-strength').value = item.drivingMultiplier.toFixed(2);
    byId('photo-wink-strength-value').value = `${item.drivingMultiplier.toFixed(2)}×`;
    byId('photo-wink-source-scale').value = item.sourceScale.toFixed(1);
    byId('photo-wink-source-scale-value').value = `${item.sourceScale.toFixed(1)}×`;
    byId('photo-wink-preserve-body').checked = item.composition === 'full-image-pasteback';
    photoWinkCandidate = { photo, action: '眨眨眼', candidateId: item.id, landmarkRoute: item.landmarkRoute,
      composition: item.composition, clipUrl: portraitReviewAsset(item.id, 'clip.mp4') };
    byId('photo-wink-review').src = portraitReviewAsset(item.id, 'review-190px.jpg');
    byId('photo-wink-video').src = photoWinkCandidate.clipUrl;
    byId('photo-wink-video').load();
    byId('photo-wink-meta').textContent = `${item.landmarkRoute === 'manual-nine-point' ? '手工九点，跳过 X-Pose 检测' : 'X-Pose 科研'} · 幅度 ${item.drivingMultiplier.toFixed(2)}× · ${item.sourceCrop ? '蒙版主体取景，保留原照像素' : item.composition === 'full-image-pasteback' ? '保留完整照片轮廓' : '脸部取景'} · 取景 ${item.sourceScale.toFixed(1)}× · ${item.frameCount} 帧 · ${item.fps} fps · 本机 ${item.generationSeconds.toFixed(1)} 秒${item.planTrace ? ` · AI 计划 ${item.planTrace.planId.slice(0, 8)} 的幅度建议` : ''} · 有背景 · 未分割、未安装`;
    byId('photo-wink-result').hidden = false;
    renderPortraitHistory();
  }
  byId('photo-wink-strength').addEventListener('input', (event) => {
    byId('photo-wink-strength-value').value = `${Number(event.currentTarget.value).toFixed(2)}×`;
    aiWinkApplied = null;
    byId('photo-wink-plan-note').hidden = true;
  });
  byId('photo-wink-source-scale').addEventListener('input', (event) => {
    byId('photo-wink-source-scale-value').value = `${Number(event.currentTarget.value).toFixed(1)}×`;
  });
  byId('photo-wink-manual-mode').addEventListener('change', () => {
    byId('photo-wink-manual-confirm').checked = false;
    renderActionSuitability();
    refreshPromptPlanPreview();
    renderPortraitHistory();
  });
  ui.photo.addEventListener('load', () => renderManualFace());
  byId('photo-wink-manual-canvas').addEventListener('click', (event) => {
    if (photoWinkBusy || !manualWinkSelected() || manualFace.photo !== photoSource ||
        (!manualFace.choosingZoom && manualFace.points.length >= 9 && manualFace.editingIndex===null)) return;
    const canvas = event.currentTarget;
    if (!canvas.width || !canvas.height || !ui.photo.complete || !ui.photo.naturalWidth) return;
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (manualFace.choosingZoom) {
      const width = 0.25;
      const height = 0.25;
      const left = Math.max(0, Math.min(1 - width, x - width / 2));
      const top = Math.max(0, Math.min(1 - height, y - height / 2));
      manualFace.viewBox = [left, top, left + width, top + height];
      manualFace.choosingZoom = false;
      renderActionSuitability();
      return;
    }
    const [left, top, right, bottom] = manualFace.viewBox;
    const point=[Number((left + x * (right - left)).toFixed(6)),Number((top + y * (bottom - top)).toFixed(6))];
    if(manualFace.editingIndex!==null){manualFace.points[manualFace.editingIndex]=point;manualFace.editingIndex=null;byId('photo-wink-manual-edit').value='';}
    else manualFace.points.push(point);
    byId('photo-wink-manual-confirm').checked = false;
    renderActionSuitability();
  });
  byId('photo-wink-manual-undo').addEventListener('click', () => {
    if (photoWinkBusy) return;
    manualFace.points.pop();
    manualFace.editingIndex=null;byId('photo-wink-manual-edit').value='';
    byId('photo-wink-manual-confirm').checked = false;
    renderActionSuitability();
  });
  byId('photo-wink-manual-zoom').addEventListener('click', () => {
    if (photoWinkBusy) return;
    if (manualFace.choosingZoom) manualFace.choosingZoom = false;
    else if (manualFace.viewBox[2] < 1) manualFace.viewBox = [0, 0, 1, 1];
    else manualFace.choosingZoom = true;
    renderActionSuitability();
  });
  byId('photo-wink-manual-clear').addEventListener('click', () => {
    if (photoWinkBusy) return;
    manualFace.points = [];
    manualFace.draftEvidence=null;
    manualFace.editingIndex=null;byId('photo-wink-manual-edit').value='';
    byId('photo-wink-manual-confirm').checked = false;
    renderActionSuitability();
  });
  byId('photo-wink-manual-confirm').addEventListener('change', renderActionSuitability);
  byId('photo-wink-manual-edit').addEventListener('change',event=>{
    manualFace.editingIndex=event.currentTarget.value==='' ? null : Number(event.currentTarget.value);
    byId('photo-wink-manual-confirm').checked=false;renderActionSuitability();
  });
  const faceDraftValid=draft=>{
    const keys=['kind','version','route','species','sourceSha256','imageSize','pointsNormalized','sourceIndices','modelRevision','modelSha256','modelReportSha256','mappingWorkerSha256','license','singleFaceAssumed','confidenceAvailable','remoteNetworkUsed','approved','facePointsConfirmed','installable'];
    if(!draft || Object.keys(draft).sort().join(',')!==keys.sort().join(',') || draft.kind!=='ai-pet-face-point-draft' || draft.version!==1 || draft.route!=='local-landmark-exploratory-v1' || !['cat','dog'].includes(draft.species))return false;
    if(!['sourceSha256','modelReportSha256','mappingWorkerSha256'].every(k=>/^[a-f0-9]{64}$/.test(draft[k])) || !/^[a-f0-9]{40}$/.test(draft.modelRevision))return false;
    const names=[`${draft.species}_face_landmarks_full.tflite`,`${draft.species}_face_localizer.tflite`];
    if(!draft.modelSha256 || Object.keys(draft.modelSha256).sort().join(',')!==names.sort().join(',') || !Object.values(draft.modelSha256).every(v=>/^[a-f0-9]{64}$/.test(v)))return false;
    const count=draft.species==='cat' ? 48 : 46;
    return draft.license==='CC-BY-NC-4.0' && draft.singleFaceAssumed===true && draft.confidenceAvailable===false && draft.remoteNetworkUsed===false && draft.approved===false && draft.facePointsConfirmed===false && draft.installable===false &&
      Array.isArray(draft.imageSize) && draft.imageSize.length===2 && draft.imageSize.every(v=>Number.isInteger(v) && v>0 && v<=4096) &&
      Array.isArray(draft.sourceIndices) && draft.sourceIndices.length===9 && draft.sourceIndices.every(g=>Array.isArray(g) && g.length>=1 && g.length<=2 && g.every(i=>Number.isInteger(i) && i>=0 && i<count)) &&
      Array.isArray(draft.pointsNormalized) && draft.pointsNormalized.length===9 && draft.pointsNormalized.every(p=>Array.isArray(p) && p.length===2 && p.every(v=>typeof v==='number' && Number.isFinite(v) && v>0 && v<1));
  };
  const applyFaceDraft=(draft,source,dimensions,before,digest)=>{
    if(!faceDraftValid(draft))throw new Error('草稿格式或未确认状态无法核验');
    if(source!==photoSource || dimensions.join(',')!==[ui.photo.naturalWidth,ui.photo.naturalHeight].join(',') || before!==JSON.stringify(manualFace.points))throw new Error('读取期间照片或点位已变化');
    if(draft.sourceSha256!==digest || draft.imageSize.join(',')!==dimensions.join(','))throw new Error('草稿不属于当前照片');
    manualFace.photo=source;manualFace.points=draft.pointsNormalized.map(p=>[...p]);manualFace.draftEvidence=draft;
    manualFace.viewBox=[0,0,1,1];manualFace.choosingZoom=false;manualFace.editingIndex=null;
    byId('photo-wink-manual-edit').value='';byId('photo-wink-manual-confirm').checked=false;
    byId('photo-wink-manual-storage-status').textContent=`已打开${draft.species==='cat' ? '猫' : '狗'}的实验模型草稿；模型没有置信度，也不证明只有一只宠物。请检查九点并按需修正，再勾选确认。`;
  };
  const showFaceBackend=state=>{
    faceBackendReady=state?.ready===true && state.route==='local-landmark-exploratory-v1' && state.remoteNetworkUsed===false && state.approved===false && state.confidenceAvailable===false;
    byId('photo-face-backend-root').value=state?.configuration?.root || '';
    byId('photo-face-backend-status').textContent=faceBackendReady ? '本机定位可用；请先选猫或狗。提出九点草稿后仍须核对，不能确认单宠或批准动作。' : `本机定位未就绪：${state?.unavailableReason || '未配置模型目录'}。可手动标注或打开已有草稿。`;
    renderManualFace();
  };
  const saveFaceBackend=async(disable)=>{
    if(manualFaceStorageBusy || photoWinkBusy)return;manualFaceStorageBusy=true;renderManualFace();
    try{
      const response=await fetch('http://127.0.0.1:4180/api/face-backend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root:disable ? null : byId('photo-face-backend-root').value.trim()}),signal:AbortSignal.timeout(20000)});
      const state=await response.json();if(!response.ok)throw new Error(state.error || '目录检查失败');showFaceBackend(state);
    }catch(error){byId('photo-face-backend-status').textContent=`配置未保存：${error.message}。已有目录设置保持。`;}
    finally{manualFaceStorageBusy=false;renderManualFace();}
  };
  byId('photo-face-backend-save').addEventListener('click',()=>saveFaceBackend(false));
  byId('photo-face-backend-disable').addEventListener('click',()=>saveFaceBackend(true));
  byId('photo-face-run').addEventListener('click',async()=>{
    if(manualFaceStorageBusy || photoWinkBusy || !faceBackendReady || !manualWinkSelected())return;
    manualFaceStorageBusy=true;const source=photoSource;const dimensions=[ui.photo.naturalWidth,ui.photo.naturalHeight];const before=JSON.stringify(manualFace.points);const species=byId('photo-face-species').value;const status=byId('photo-wink-manual-storage-status');renderManualFace();status.textContent='本机模型正在提出九点草稿……';
    try{
      const blob=await portraitPhotoSourceBlob(source);const digest=await localSha256(blob);const encoded=await blobToBase64(blob);
      if(source!==photoSource)throw new Error('照片已变化');
      const response=await fetch('http://127.0.0.1:4180/api/face-points',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageBase64:encoded,photoSha256:digest,species}),signal:AbortSignal.timeout(200000)});
      const draft=await response.json();if(!response.ok)throw new Error(draft.error || '本机定位失败');
      if(draft.species!==species || byId('photo-face-species').value!==species)throw new Error('宠物类型与请求不一致');
      applyFaceDraft(draft,source,dimensions,before,digest);
    }catch(error){status.textContent=`本机定位未完成：${error.message}。当前点位和旧记录保留，未自动确认。`;}
    finally{manualFaceStorageBusy=false;renderActionSuitability();}
  });
  draftInput.addEventListener('change',async()=>{
    const file=draftInput.files?.[0];draftInput.value='';
    if(!file || manualFaceStorageBusy || photoWinkBusy)return;
    manualFaceStorageBusy=true;const source=photoSource;const dimensions=[ui.photo.naturalWidth,ui.photo.naturalHeight];const before=JSON.stringify(manualFace.points);const status=byId('photo-wink-manual-storage-status');renderManualFace();
    try{
      if(file.size>65536)throw new Error('草稿文件过大');
      const draft=JSON.parse(await file.text());if(!faceDraftValid(draft))throw new Error('草稿格式或未确认状态无法核验');
      const digest=await localSha256(await portraitPhotoSourceBlob(source));
      applyFaceDraft(draft,source,dimensions,before,digest);
    }catch(error){status.textContent=`草稿未打开：${error.message}。当前点位和旧记录保留。`;}
    finally{manualFaceStorageBusy=false;renderActionSuitability();}
  });
  const faceRecordValid=record=>record && record.version===1 && /^[a-f0-9]{64}$/.test(record.photoSha256) &&
    (record.draftEvidence==null || (faceDraftValid(record.draftEvidence) && record.draftEvidence.sourceSha256===record.photoSha256 && record.draftEvidence.imageSize.join(',')===record.imageSize?.join(','))) &&
    Array.isArray(record.imageSize) && record.imageSize.length===2 && record.imageSize.every(v=>Number.isInteger(v) && v>0 && v<=4096) &&
    Array.isArray(record.pointsNormalized) && record.pointsNormalized.length===9 && record.pointsNormalized.every(p=>Array.isArray(p) && p.length===2 && p.every(v=>typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1));
  const useSavedFace=async(save)=>{
    if(manualFaceStorageBusy || photoWinkBusy || (save && (!manualFaceReady() || manualFace.editingIndex!==null)))return;
    manualFaceStorageBusy=true;const source=photoSource;const points=JSON.parse(JSON.stringify(manualFace.points));const dimensions=[ui.photo.naturalWidth,ui.photo.naturalHeight];
    renderManualFace();const status=byId('photo-wink-manual-storage-status');
    try{
      const digest=await localSha256(await portraitPhotoSourceBlob(source));
      if(source!==photoSource || dimensions[0]!==ui.photo.naturalWidth || dimensions[1]!==ui.photo.naturalHeight)throw new Error('照片已变化，未关联旧点位');
      if(JSON.stringify(points)!==JSON.stringify(manualFace.points))throw new Error('读取期间点位已变化，请重新打开');
      const records=JSON.parse(localStorage.getItem(manualFaceStorageKey)||'[]');
      if(!Array.isArray(records) || records.length>32 || records.some(r=>!faceRecordValid(r)))throw new Error('已保存点位记录无法核验，保留原记录');
      if(save){
        if(!manualFaceReady() || JSON.stringify(points)!==JSON.stringify(manualFace.points))throw new Error('点位或确认已变化，请重新核对');
        const record={version:1,photoSha256:digest,imageSize:dimensions,pointsNormalized:points,route:'human-nine-point',approved:false};
        if(manualFace.draftEvidence){record.route='human-reviewed-local-model-nine-point';record.draftEvidence=manualFace.draftEvidence;}
        if(!faceRecordValid(record))throw new Error('当前点位无法保存');
        localStorage.setItem(manualFaceStorageKey,JSON.stringify([record,...records.filter(r=>r.photoSha256!==digest)].slice(0,32)));
        status.textContent='已按照片指纹保存九点，只有点位保存在本机；不批准动作或主题。';
      }else{
        const record=records.find(r=>r.photoSha256===digest);
        if(!record)throw new Error('当前照片没有已保存点位');
        if(record.imageSize.join(',')!==dimensions.join(','))throw new Error('照片尺寸与保存记录不一致');
        manualFace.points=record.pointsNormalized.map(p=>[...p]);manualFace.photo=source;manualFace.viewBox=[0,0,1,1];manualFace.choosingZoom=false;manualFace.editingIndex=null;
        manualFace.draftEvidence=record.draftEvidence || null;
        byId('photo-wink-manual-edit').value='';byId('photo-wink-manual-confirm').checked=false;
        status.textContent='已打开当前照片九点；请核对或逐点修正，并重新勾选确认。';
      }
    }catch(error){status.textContent=`${save ? '保存' : '打开'}未完成：${error.message}。当前点位和旧记录保留。`;}
    finally{manualFaceStorageBusy=false;renderActionSuitability();}
  };
  byId('photo-wink-manual-save').addEventListener('click',()=>useSavedFace(true));
  byId('photo-wink-manual-load').addEventListener('click',()=>useSavedFace(false));
  byId('photo-wink-preserve-body').addEventListener('change', (event) => {
    if (!event.currentTarget.checked) clearPortraitFraming();
    renderActionSuitability();
  });
  byId('photo-wink-framing-prepare').addEventListener('click', () => {
    const status = byId('photo-wink-status');
    clearPortraitFraming();
    try {
      if (photoWinkBusy || !fullBodyPhotoEligible() || !byId('photo-wink-preserve-body').checked ||
          segmentationPreviewPhoto !== photoSource || !segmentationEditor.canvas || byId('segmentation-result').hidden)
        throw new Error('请先对当前完整主照片运行分割并确认单宠、无遮挡及完整轮廓。');
      if (segmentationEditor.edgeReview?.possibleCropSides?.length)
        throw new Error('原始分割候选曾触到照片边缘；修整蒙版不能补回画外身体，请换完整照片。');
      if (segmentationEditor.regionReview?.possibleExtraForeground)
        throw new Error('分割候选含多块显著前景，请先核对并重新分割完整主体。');
      const source = segmentationEditor.sourceImage;
      const canvas = segmentationEditor.canvas;
      const width = canvas.width;
      const height = canvas.height;
      if (!source || source.naturalWidth !== width || source.naturalHeight !== height ||
          ui.photo.naturalWidth !== width || ui.photo.naturalHeight !== height || width < 256 || height < 256)
        throw new Error('分割蒙版与当前主照片尺寸不一致，请重新分割。');
      const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (pixels[(y * width + x) * 4 + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      if (right < left || bottom < top) throw new Error('当前蒙版没有透明主体。');
      if (left === 0 || top === 0 || right === width - 1 || bottom === height - 1)
        throw new Error('当前蒙版触到画框，不能确认全身取景不会裁断。');
      const margin = Math.max(8, Math.ceil(Math.max(right - left + 1, bottom - top + 1) * 0.04));
      const crop = [Math.max(0, left - margin), Math.max(0, top - margin),
        Math.min(width, right + 1 + margin), Math.min(height, bottom + 1 + margin)];
      if (crop[2] - crop[0] < 256 || crop[3] - crop[1] < 256 ||
          (crop[2] - crop[0] === width && crop[3] - crop[1] === height))
        throw new Error('没有安全的主体取景空间；可直接使用完整照片生成待审候选。');
      const review = document.createElement('canvas');
      review.width = 390;
      review.height = 284;
      const context = review.getContext('2d');
      context.fillStyle = '#f4eee0';
      context.fillRect(0, 0, review.width, review.height);
      const drawContained = (sx, sy, sw, sh, dx) => {
        const scale = Math.min(190 / sw, 254 / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        context.drawImage(source, sx, sy, sw, sh, dx + (190 - dw) / 2, 25 + (254 - dh) / 2, dw, dh);
      };
      context.fillStyle = '#5a5042';
      context.font = '12px sans-serif';
      context.textAlign = 'center';
      context.fillText('当前原照', 95, 17);
      context.fillText('保留蒙版主体的 RGB 取景', 295, 17);
      drawContained(0, 0, width, height, 0);
      drawContained(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1], 200);
      portraitFraming = { photo: photoSource, revision: segmentationCandidateRevision, canvas,
        crop, sourceSize: [width, height] };
      byId('photo-wink-framing-image').src = review.toDataURL('image/jpeg', 0.93);
      byId('photo-wink-framing-note').textContent = `原照 ${width}×${height} → RGB 取景 ${crop[2] - crop[0]}×${crop[3] - crop[1]}。只取原照像素；仍带背景，生成后还需逐帧分割与审核。`;
      byId('photo-wink-framing-review').hidden = false;
      status.textContent = '请核对两张 190px 预览，确认主体完整后再生成。';
    } catch (error) {
      status.textContent = `无法准备全身主体取景：${error.message}`;
    }
    renderActionSuitability();
  });
  byId('photo-wink-framing-confirm').addEventListener('change', renderActionSuitability);
  byId('photo-wink-framing-cancel').addEventListener('click', () => {
    clearPortraitFraming();
    byId('photo-wink-status').textContent = '已取消主体取景；生成时将使用完整主照片。';
    renderActionSuitability();
  });
  byId('photo-wink-license-consent').addEventListener('change', (event) => {
    xposeResearchConsent = event.currentTarget.checked;
    try {
      if (xposeResearchConsent) sessionStorage.setItem(xposeConsentKey, 'accepted');
      else sessionStorage.removeItem(xposeConsentKey);
    } catch { /* The gate still applies for this page session. */ }
    if (!xposeResearchConsent) byId('photo-wink-video').pause();
    renderActionSuitability();
    renderPortraitHistory();
  });
  async function restorePortraitCandidate(item) {
    const photo = photoSource;
    const key = portraitPhotoKey;
    const status = byId('photo-wink-status');
    if ((item.landmarkRoute !== 'manual-nine-point' && !xposeResearchConsent) || !key || ![key, portraitLegacyPhotoKey].includes(item.photoKey) || currentAction !== '眨眨眼') return;
    if (item.composition === 'full-image-pasteback' && !fullBodyPhotoEligible()) {
      status.textContent = '这段完整照片候选需要重新确认当前主照片的完整轮廓、无遮挡和单宠。';
      return;
    }
    status.textContent = '正在确认本机候选文件是否仍可读取……';
    try {
      const response = await fetch(portraitReviewAsset(item.id, 'review-190px.jpg'), { signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/jpeg')) throw new Error('审核图已不在工作区，请重新生成。');
      if (photo !== photoSource || key !== portraitPhotoKey || currentAction !== '眨眨眼') throw new Error('角色照片或动作已变化。');
      showPortraitCandidate(item, photo);
      renderActionSuitability();
      status.textContent = '已找回本机眨眼候选。请再次核对身份和动作，再继续分割。';
    } catch (error) {
      status.textContent = error instanceof TypeError ? '无法连接本机 LivePortrait 服务；请先启动服务再找回候选。' : `无法找回候选：${error.message}`;
    }
  }
  function normalizeVideoCandidate(value) {
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{32}$/.test(value.id) ||
      typeof value.sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceKey) ||
      !Number.isInteger(value.fps) || value.fps < 1 || value.fps > 30 ||
      !Number.isInteger(value.frameCount) || value.frameCount < 2 || value.frameCount > 120 ||
      !Number.isInteger(value.positiveCount) || value.positiveCount < 1 || value.positiveCount > 32 ||
      !Number.isInteger(value.negativeCount) || value.negativeCount < 0 || value.positiveCount + value.negativeCount > 32 ||
      !Number.isFinite(value.inferenceSeconds) || value.inferenceSeconds < 0 ||
      !Number.isFinite(value.peakCudaMemoryGiB) || value.peakCudaMemoryGiB < 0 ||
      !Number.isSafeInteger(value.transparentPixels) || value.transparentPixels < 1 ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
    const reviewIssue = typeof value.reviewIssue === 'string' && Object.hasOwn(videoReviewIssues, value.reviewIssue) ? value.reviewIssue : '';
    const automaticVetoReason = ['motion', 'crop'].includes(value.automaticVetoReason) ? value.automaticVetoReason : null;
    const alphaMapping = typeof value.alphaMapping === 'string' && Object.hasOwn(videoAlphaMappings, value.alphaMapping) ? value.alphaMapping : 'unknown';
    const borderContact = normalizeBorderContact(value.borderContact, value.frameCount);
    const reviewSampling = normalizeReviewSampling(value.reviewSampling, value.frameCount);
    const checkedFrames = value.frameReview && Array.isArray(value.frameReview.checkedFrames) &&
      value.frameReview.checkedFrames.length <= value.frameCount &&
      value.frameReview.checkedFrames.every((frame, index, frames) =>
        Number.isInteger(frame) && frame >= 1 && frame <= value.frameCount && (index === 0 || frames[index - 1] < frame))
      ? [...value.frameReview.checkedFrames] : [];
    const visualReview = value.visualReview && typeof value.visualReview === 'object' &&
      Array.isArray(value.visualReview.checks) && value.visualReview.checks.length <= videoVisualReviewChecks.length &&
      value.visualReview.checks.every((key, index, checks) => videoVisualReviewChecks.includes(key) && checks.indexOf(key) === index) &&
      (value.visualReview.reviewedAt === '' || typeof value.visualReview.reviewedAt === 'string' && Number.isFinite(Date.parse(value.visualReview.reviewedAt)))
      ? { checks: [...value.visualReview.checks], reviewedAt: value.visualReview.reviewedAt } : { checks: [], reviewedAt: '' };
    return { id: value.id, sourceKey: value.sourceKey,
      fps: value.fps, frameCount: value.frameCount, positiveCount: value.positiveCount,
      negativeCount: value.negativeCount, inferenceSeconds: value.inferenceSeconds,
      peakCudaMemoryGiB: value.peakCudaMemoryGiB, transparentPixels: value.transparentPixels,
      createdAt: value.createdAt, reviewIssue, automaticVetoReason, alphaMapping, borderContact, reviewSampling,
      planSnapshot: value.planSnapshot == null ? null : normalizeVideoPlanSnapshot(value.planSnapshot),
      visualReview, frameReview: { checkedFrames } };
  }
  function loadVideoHistory() {
    try {
      const values = JSON.parse(localStorage.getItem(videoHistoryKey) || '[]');
      if (!Array.isArray(values)) return [];
      const seen = new Set();
      return values.map(normalizeVideoCandidate).filter((value) => {
        if (!value || seen.has(value.id)) return false;
        seen.add(value.id);
        return true;
      }).slice(0, videoHistoryLimit);
    } catch { return []; }
  }
  function saveVideoHistory() {
    try {
      localStorage.setItem(videoHistoryKey, JSON.stringify(sam2VideoState.history));
      sam2VideoState.historySaved = true;
    } catch { sam2VideoState.historySaved = false; }
  }
  async function writeVideoReviewDecision(candidateId, reason) {
    const response = await fetch('http://127.0.0.1:4175/api/review-disposition', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId, reason: reason || null }), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || result.status !== (reason ? 'needs-work' : 'pending') || result.reason !== (reason || null))
      throw new Error(result.error || '本机审核记录未保存');
  }
  async function syncVideoReviewDecisions(sourceKey) {
    sam2VideoState.reviewSyncWarning = false;
    for (const item of sam2VideoState.history.filter((value) => value.sourceKey === sourceKey)) {
      try {
        const response = await fetch(videoReviewAsset(item.id, 'disposition'), { signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok || !['pending', 'needs-work'].includes(result.status) ||
          ![null, 'motion', 'crop'].includes(result.automaticVetoReason) ||
          (result.automaticVetoReason && result.status !== 'needs-work') ||
          (result.status === 'needs-work' && !Object.hasOwn(videoReviewIssues, result.reason)))
          throw new Error('本机审核状态不可用');
        const issue = result.status === 'needs-work' ? result.reason : '';
        item.automaticVetoReason = result.automaticVetoReason;
        item.alphaMapping = Object.hasOwn(videoAlphaMappings, result.alphaMapping) ? result.alphaMapping : 'unknown';
        item.borderContact = normalizeBorderContact(result.borderContact, item.frameCount);
        item.reviewSampling = normalizeReviewSampling(result.reviewSampling, item.frameCount);
        item.reviewNeedsSync = !issue && !!item.reviewIssue;
        if (item.reviewNeedsSync) sam2VideoState.reviewSyncWarning = true;
        else if (item.reviewIssue !== issue) item.reviewIssue = issue;
      } catch {
        sam2VideoState.reviewSyncWarning = true;
      }
    }
    if (sam2VideoState.sourceKey !== sourceKey) return;
    saveVideoHistory();
    if (activeReviewCandidate && candidateReviewIssue(activeReviewCandidate.id)) {
      activeReviewCandidate = null;
      renderWorkshopCandidate();
      persistDraft();
    }
    renderCharacterLibrary();
  }
  let videoReviewFrameRequest = 0;
  function videoReviewedFrameCount(candidate) {
    return candidate.frameReview?.checkedFrames.length || 0;
  }
  function showVideoReviewFrame(candidate, requested) {
    const range = byId('sam2-frame-range');
    const frame = Math.max(1, Math.min(candidate.frameCount, Math.round(Number(requested) || 1)));
    const request = ++videoReviewFrameRequest;
    range.min = '1';
    range.max = String(candidate.frameCount);
    range.value = String(frame);
    range.dataset.candidateId = candidate.id;
    range.dataset.frameReady = 'false';
    byId('sam2-frame-count').textContent = `第 ${frame} / ${candidate.frameCount} 帧`;
    byId('sam2-frame-progress').textContent = `已检查 ${videoReviewedFrameCount(candidate)} / ${candidate.frameCount} 帧`;
    byId('sam2-frame-prev').disabled = frame === 1;
    byId('sam2-frame-next').disabled = frame === candidate.frameCount;
    const mark = byId('sam2-frame-mark');
    const alreadyChecked = candidate.frameReview?.checkedFrames.includes(frame);
    mark.textContent = alreadyChecked ? '✓ 当前帧已检查' : '确认当前帧已检查';
    mark.disabled = true;
    byId('sam2-frame-status').textContent = '正在读取当前帧；检查三种背景后再确认。';
    const asset = `http://127.0.0.1:4175/api/review/${candidate.id}/frame/${String(frame).padStart(6, '0')}`;
    const images = [...document.querySelectorAll('[data-frame-background]')];
    images.forEach((image) => {
      image.src = asset;
    });
    Promise.all(images.map((image) => image.decode())).then(() => {
      if (request !== videoReviewFrameRequest) return;
      range.dataset.frameReady = 'true';
      mark.disabled = !!alreadyChecked;
      byId('sam2-frame-status').textContent = '当前帧已加载。请在暖色、蓝色、深色背景检查轮廓和残留，再确认；也要播放正常速度动画。';
    }).catch(() => {
      if (request !== videoReviewFrameRequest) return;
      byId('sam2-frame-status').textContent = '这一帧无法读取；候选文件可能已清理。请勿据此确认整段边缘质量。';
    });
  }
  function setupVideoFrameInspector(candidate) {
    const range = byId('sam2-frame-range');
    const previous = range.dataset.candidateId === candidate.id ? Number(range.value) : 1;
    const focus = byId('sam2-frame-focus');
    focus.replaceChildren();
    const important = new Map([[1, '首帧'], [candidate.frameCount, '末帧']]);
    const worst = candidate.reviewSampling?.worstFrames;
    for (const [key, label] of [['maskJump', '跳变'], ['borderContact', '边缘'], ['areaChange', '面积']]) {
      const frame = worst?.[key];
      if (Number.isInteger(frame) && frame >= 1 && frame <= candidate.frameCount)
        important.set(frame, important.has(frame) ? `${important.get(frame)}、${label}` : label);
    }
    for (const [frame, label] of important) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${label} · ${frame}`;
      button.addEventListener('click', () => showVideoReviewFrame(candidate, frame));
      focus.append(button);
    }
    showVideoReviewFrame(candidate, previous);
  }
  const frameActions = document.createElement('div');
  frameActions.className = 'sam2-frame-actions';
  frameActions.innerHTML = '<span id="sam2-frame-progress" role="status">已检查 0 / 0 帧</span><button type="button" id="sam2-frame-mark" disabled>确认当前帧已检查</button><button type="button" id="sam2-frame-unchecked">下一未检查帧</button>';
  byId('sam2-frame-status').before(frameActions);
  byId('sam2-frame-mark').addEventListener('click', () => {
    const range = byId('sam2-frame-range');
    const candidate = sam2VideoState.history.find((item) => item.id === sam2VideoState.selectedCandidateId);
    const frame = Number(range.value);
    if (!candidate || range.dataset.candidateId !== candidate.id || range.dataset.frameReady !== 'true' ||
      candidate.frameReview?.checkedFrames.includes(frame)) return;
    const previous = candidate.frameReview?.checkedFrames || [];
    candidate.frameReview = { checkedFrames: [...previous, frame].sort((a, b) => a - b) };
    saveVideoHistory();
    if (!sam2VideoState.historySaved) {
      candidate.frameReview = { checkedFrames: previous };
      displayVideoCandidate(candidate);
      tell('本机无法保存逐帧审核进度；当前帧没有记为已检查。');
      return;
    }
    displayVideoCandidate(candidate);
    const next = Array.from({ length: candidate.frameCount }, (_, index) => index + 1)
      .find((value) => !candidate.frameReview.checkedFrames.includes(value));
    if (next) showVideoReviewFrame(candidate, next);
  });
  byId('sam2-frame-unchecked').addEventListener('click', () => {
    const candidate = sam2VideoState.history.find((item) => item.id === sam2VideoState.selectedCandidateId);
    if (!candidate) return;
    const next = Array.from({ length: candidate.frameCount }, (_, index) => index + 1)
      .find((frame) => !candidate.frameReview?.checkedFrames.includes(frame));
    if (next) showVideoReviewFrame(candidate, next);
  });
  byId('sam2-frame-range').addEventListener('input', (event) => {
    const candidate = sam2VideoState.history.find((item) => item.id === sam2VideoState.selectedCandidateId);
    if (candidate) showVideoReviewFrame(candidate, event.currentTarget.value);
  });
  for (const [id, offset] of [['sam2-frame-prev', -1], ['sam2-frame-next', 1]]) {
    byId(id).addEventListener('click', () => {
      const candidate = sam2VideoState.history.find((item) => item.id === sam2VideoState.selectedCandidateId);
      if (candidate) showVideoReviewFrame(candidate, Number(byId('sam2-frame-range').value) + offset);
    });
  }
  function displayVideoCandidate(candidate) {
    if (candidate.sourceKey !== sam2VideoState.sourceKey) return;
    const reviewUrl = videoReviewAsset(candidate.id, 'review-190px-warm-blue.jpg');
    const loopUrl = videoReviewAsset(candidate.id, 'review-190px-loop.gif');
    const packageUrl = videoReviewAsset(candidate.id, 'candidate.lotheme');
    byId('sam2-video-contact').src = reviewUrl;
    byId('sam2-video-contact-open').href = reviewUrl;
    byId('sam2-video-loop').src = loopUrl;
    byId('sam2-video-loop-title').textContent = `${candidate.fps} fps 透明动作 · 蓝色背景`;
    byId('sam2-video-loop-download').href = loopUrl;
    byId('sam2-video-result-title').textContent = candidate.reviewIssue ? '需修改的视频候选' : '待审核视频候选';
    const planMatchesContext = !candidate.planSnapshot || videoPlanSnapshotMatchesContext(candidate.planSnapshot, roleVideoContext);
    const needsRoleConfirmation = candidate.planSnapshot
      ? !roleVideoContextIsCurrent() || !planMatchesContext || !byId('sam2-video-role-confirm').checked
      : !!roleVideoContext && (!roleVideoContextIsCurrent() || !byId('sam2-video-role-confirm').checked);
    const frameReviewComplete = videoReviewedFrameCount(candidate) === candidate.frameCount;
    const visualReviewComplete = videoVisualReviewChecks.every((key) => candidate.visualReview?.checks.includes(key)) &&
      !!candidate.visualReview?.reviewedAt;
    byId('sam2-video-visual-review').querySelectorAll('[data-video-review]').forEach((input) => {
      input.checked = !!candidate.visualReview?.checks.includes(input.dataset.videoReview);
    });
    byId('sam2-video-visual-review-status').textContent = visualReviewComplete
      ? `五项人工审核已确认 · ${new Date(candidate.visualReview.reviewedAt).toLocaleString('zh-CN')}。逐帧检查 ${videoReviewedFrameCount(candidate)} / ${candidate.frameCount}；该记录只表示你已逐项确认。`
      : `五项全部确认且逐帧检查 ${candidate.frameCount} 帧后，才可带入角色或导出待审包；当前已检查 ${videoReviewedFrameCount(candidate)} 帧。`;
    byId('sam2-video-role-note').textContent = candidate.reviewIssue
      ? candidate.automaticVetoReason
        ? `此候选存在自动检测到的${candidate.automaticVetoReason === 'crop' ? '持续画框裁切' : '严重蒙版跳变'}，已标为「${videoReviewIssues[candidate.reviewIssue]}」；同一素材不能撤回判定，请修正分割或重新生成。`
        : `此候选因「${videoReviewIssues[candidate.reviewIssue]}」被标为需修改，请先重做或在复查后撤回判定。`
      : needsRoleConfirmation
      ? candidate.planSnapshot && !roleVideoContext
        ? `候选来自角色「${candidate.planSnapshot.name}」的「${candidate.planSnapshot.action}」计划。请重新从该角色工坊进入并确认身份后，才能带入或下载。`
        : '请核对当前角色与候选保存的照片指纹、动作和 Prompt 是否相同，并明确确认视频主体和计划动作。'
      : '将这段动作与当前照片并排审核，并记录到角色卡；这一步不会安装素材。';
    byId('sam2-video-package-download').href = packageUrl;
    const planNote = candidate.planSnapshot
        ? ` · 原计划：${candidate.planSnapshot.name} / ${candidate.planSnapshot.action} · 已确认特征「${candidate.planSnapshot.traits?.join('、') || '未记录'}」· Prompt「${candidate.planSnapshot.prompt || '空'}」${candidate.planSnapshot.sourceCandidate ? ` · ${candidate.planSnapshot.sourceCandidate.model} ${candidate.planSnapshot.sourceCandidate.id.slice(0, 8)}（${candidate.planSnapshot.sourceCandidate.composition === 'rgba-anchor-i2v' ? '透明锚图' : candidate.planSnapshot.sourceCandidate.composition === 'full-image-pasteback' ? '完整照片' : '脸部取景'}）` : ''}`
      : ' · 未关联角色创作计划';
    byId('sam2-video-result-meta').textContent = `${candidate.frameCount} 帧 · 512×512 · ${candidate.fps} fps · ${videoAlphaMappings[candidate.alphaMapping]} · ${borderContactNote(candidate)} · ${reviewFocusNote(candidate)} · 本机推理 ${candidate.inferenceSeconds.toFixed(2)} 秒 · 峰值显存 ${candidate.peakCudaMemoryGiB.toFixed(2)} GiB${planNote}`;
    byId('sam2-video-package-status').textContent = candidate.reviewNeedsSync
      ? '旧浏览器判定与本机记录不一致；请选择同步旧判定或采用本机状态。'
      : sam2VideoState.reviewSyncWarning
      ? '本机审核记录未能核对；已暂停主题包下载与角色关联。'
      : candidate.reviewIssue
      ? `需修改：${videoReviewIssues[candidate.reviewIssue]} · 主题包仍留在工作区供复查 · 未安装`
      : !frameReviewComplete
      ? `请逐帧检查全部 ${candidate.frameCount} 帧的暖色、蓝色、深色预览；目前已检查 ${videoReviewedFrameCount(candidate)} 帧。`
      : !visualReviewComplete
      ? '请先在 190px 正常速度与完整边缘图中逐项完成五项人工审核。'
      : `五项人工审核已确认 · 结构校验通过 · ${candidate.frameCount} 帧 · ${candidate.transparentPixels.toLocaleString()} 个透明像素 · review required · 未安装`;
    byId('sam2-video-package-download').hidden = !!candidate.reviewIssue || sam2VideoState.reviewSyncWarning || needsRoleConfirmation || !frameReviewComplete || !visualReviewComplete;
    byId('sam2-video-to-workshop').disabled = !!candidate.reviewIssue || sam2VideoState.reviewSyncWarning || needsRoleConfirmation || !frameReviewComplete || !visualReviewComplete;
    sam2VideoState.selectedCandidateId = candidate.id;
    setupVideoFrameInspector(candidate);
    byId('sam2-video-result').hidden = false;
    renderVideoHistory();
  }
  byId('sam2-video-visual-review').addEventListener('change', (event) => {
    const input = event.target.closest('[data-video-review]');
    const candidate = sam2VideoState.history.find((item) => item.id === sam2VideoState.selectedCandidateId && item.sourceKey === sam2VideoState.sourceKey);
    if (!input || !candidate) return;
    const prior = candidate.visualReview?.checks || [];
    const priorReview = candidate.visualReview || { checks: [], reviewedAt: '' };
    const checks = input.checked
      ? [...new Set([...prior, input.dataset.videoReview])]
      : prior.filter((key) => key !== input.dataset.videoReview);
    candidate.visualReview = { checks, reviewedAt: videoVisualReviewChecks.every((key) => checks.includes(key)) ? new Date().toISOString() : '' };
    saveVideoHistory();
    if (!sam2VideoState.historySaved) {
      candidate.visualReview = priorReview;
      displayVideoCandidate(candidate);
      tell('本机无法保存这项审核记录；为避免丢失审核证据，角色关联和打包仍保持锁定。');
      return;
    }
    displayVideoCandidate(candidate);
  });
  function renderVideoHistory() {
    const section = byId('sam2-video-history');
    const grid = byId('sam2-video-history-grid');
    grid.replaceChildren();
    const candidates = sam2VideoState.history.filter((candidate) => candidate.sourceKey === sam2VideoState.sourceKey).slice(0, 4);
    section.hidden = candidates.length === 0;
    if (!candidates.length) return;
    byId('sam2-video-history-count').textContent = `${candidates.length} 个候选 · ${candidates.filter((item) => item.reviewIssue).length} 个需修改`;
    byId('sam2-video-history-note').textContent = !sam2VideoState.historySaved
      ? '本次候选可比较，但浏览器未能保存候选编号；关闭页面后记录可能消失。'
      : candidates.some((item) => item.reviewNeedsSync)
        ? '旧浏览器判定与本机记录不一致。请逐项选择同步旧判定，或采用本机待审状态。核对前暂停下载和角色关联。'
      : sam2VideoState.reviewSyncWarning
        ? '本机审核记录未能核对；可查看预览，但暂停主题包下载和角色关联。'
      : candidates.every((item) => item.reviewIssue)
        ? '这些候选均已标记需修改。对照问题重做；旧预览保留供复查，不会带入角色草稿。'
      : candidates.length < 2
        ? '已保存第一个候选。调整提示点或帧率后重做，即可比较；本机保存视频指纹与参数。若从角色工坊发起，也会保存角色动作、描述、确认特征和照片指纹；不会保存原照片或原视频。'
        : '对照正常速度动作和完整尺寸边缘图，再选择要查看的候选；选择不会安装主题。';
    for (const candidate of candidates) {
      const card = document.createElement('article');
      card.className = `sam2-video-history-card${candidate.id === sam2VideoState.selectedCandidateId ? ' selected' : ''}${candidate.reviewIssue ? ' needs-work' : ''}`;
      const head = document.createElement('div');
      head.className = 'sam2-video-history-card-head';
      const title = document.createElement('strong');
      title.textContent = `${candidate.fps} fps · ${candidate.frameCount} 帧`;
      const date = document.createElement('span');
      date.textContent = new Date(candidate.createdAt).toLocaleString('zh-CN');
      head.append(title, date);
      const previews = document.createElement('div');
      previews.className = 'sam2-video-history-card-preview';
      const loop = document.createElement('img');
      loop.src = videoReviewAsset(candidate.id, 'review-190px-loop.gif');
      loop.alt = `${candidate.fps} fps 候选的 190px 正常速度预览`;
      loop.loading = 'lazy';
      const contact = document.createElement('img');
      contact.src = videoReviewAsset(candidate.id, 'review-190px-warm-blue.jpg');
      contact.alt = '暖色与蓝色背景的边缘审核图';
      contact.loading = 'lazy';
      previews.append(loop, contact);
      const detail = document.createElement('p');
      const planText = candidate.planSnapshot
        ? ` · 角色计划「${candidate.planSnapshot.name} / ${candidate.planSnapshot.action}」· 特征「${candidate.planSnapshot.traits?.join('、') || '未记录'}」· Prompt「${candidate.planSnapshot.prompt || '空'}」${candidate.planSnapshot.sourceCandidate ? ` · ${candidate.planSnapshot.sourceCandidate.model} ${candidate.planSnapshot.sourceCandidate.id.slice(0, 8)}` : ''}`
        : ' · 未关联角色计划';
      const visualStatus = candidate.visualReview?.reviewedAt ? ' · 五项人工审核已确认' : ' · 五项人工审核未完成';
      detail.textContent = `前景 ${candidate.positiveCount} · 背景 ${candidate.negativeCount} · ${videoAlphaMappings[candidate.alphaMapping]} · ${borderContactNote(candidate)} · ${reviewFocusNote(candidate)} · 本机推理 ${candidate.inferenceSeconds.toFixed(2)} 秒${planText}${visualStatus} · ${candidate.reviewIssue ? `需修改：${videoReviewIssues[candidate.reviewIssue]}` : '待人工审核'}`;
      const actions = document.createElement('div');
      actions.className = 'sam2-video-history-card-actions';
      const select = document.createElement('button');
      select.type = 'button';
      select.textContent = candidate.id === sam2VideoState.selectedCandidateId ? '正在上方查看' : '在上方查看';
      select.disabled = candidate.id === sam2VideoState.selectedCandidateId;
      select.addEventListener('click', () => displayVideoCandidate(candidate));
      const full = document.createElement('a');
      full.href = videoReviewAsset(candidate.id, 'review-190px-warm-blue.jpg');
      full.target = '_blank';
      full.rel = 'noopener';
      full.textContent = '完整边缘图 ↗';
      loop.addEventListener('error', () => {
        card.classList.add('unavailable');
        select.disabled = true;
        detail.textContent = '本机候选文件不可用；工作区中的输出可能已被清理。';
      }, { once: true });
      actions.append(select, full);
      const issueSelect = document.createElement('select');
      issueSelect.setAttribute('aria-label', '选择候选的质量问题');
      issueSelect.append(new Option('选择质量问题', ''));
      Object.entries(videoReviewIssues).forEach(([key, label]) => issueSelect.append(new Option(label, key)));
      issueSelect.value = candidate.reviewIssue || '';
      issueSelect.hidden = !!candidate.reviewIssue;
      const disposition = document.createElement('button');
      disposition.type = 'button';
      disposition.textContent = candidate.automaticVetoReason ? '自动拦截，需重新生成' : candidate.reviewNeedsSync ? '确认并同步旧判定' : candidate.reviewIssue ? '撤回需修改判定' : '标记需修改';
      disposition.disabled = !!candidate.automaticVetoReason || sam2VideoState.reviewSyncWarning && !candidate.reviewNeedsSync;
      disposition.addEventListener('click', async () => {
        if (!candidate.reviewIssue && !issueSelect.value) { tell('先选择可见的质量问题，再记录判定。'); return; }
        const issue = candidate.reviewNeedsSync ? candidate.reviewIssue : candidate.reviewIssue ? '' : issueSelect.value;
        disposition.disabled = true;
        try { await writeVideoReviewDecision(candidate.id, issue); }
        catch (error) {
          disposition.disabled = false;
          tell(error?.message === 'review-ledger-unavailable'
            ? '本机审核记录文件无法读写；请检查存储目录权限。候选状态没有改变。'
            : '本机审核记录未写入，候选状态没有改变。请确认视频服务正在运行。');
          return;
        }
        sam2VideoState.history = sam2VideoState.history.map((item) => item.id === candidate.id ? { ...item, reviewIssue: issue, reviewNeedsSync: false } : item);
        saveVideoHistory();
        await syncVideoReviewDecisions(candidate.sourceKey);
        if (issue && activeReviewCandidate?.id === candidate.id) {
          activeReviewCandidate = null;
          renderWorkshopCandidate();
          persistDraft();
        }
        const current = sam2VideoState.history.find((item) => item.id === candidate.id);
        if (sam2VideoState.selectedCandidateId === candidate.id) displayVideoCandidate(current);
        else renderVideoHistory();
        renderCharacterLibrary();
        tell(issue ? `已记录「${videoReviewIssues[issue]}」；此候选不能带入角色工坊。` : '已撤回需修改判定；候选回到待审状态。');
      });
      actions.append(issueSelect, disposition);
      if (candidate.reviewNeedsSync) {
        const acceptCurrent = document.createElement('button');
        acceptCurrent.type = 'button';
        acceptCurrent.textContent = '采用本机待审状态';
        acceptCurrent.addEventListener('click', async () => {
          candidate.reviewIssue = '';
          candidate.reviewNeedsSync = false;
          await syncVideoReviewDecisions(candidate.sourceKey);
          if (sam2VideoState.selectedCandidateId === candidate.id) displayVideoCandidate(candidate);
          else renderVideoHistory();
          tell('已采用本机审核记录中的待审状态；继续检查画质后再决定是否使用。');
        });
        actions.append(acceptCurrent);
      }
      card.append(head, previews, detail, actions);
      grid.append(card);
    }
  }
  sam2VideoState.history = loadVideoHistory();
  if (activeReviewCandidate && candidateReviewIssue(activeReviewCandidate.id)) {
    activeReviewCandidate = null;
    renderWorkshopCandidate();
    persistDraft();
  }
  renderCharacterLibrary();
  function drawFit(context, image, x, y, width, height) {
    const scale = Math.max(width / image.width, height / image.height);
    const cropWidth = width / scale;
    const cropHeight = height / scale;
    context.drawImage(image, (image.width - cropWidth) / 2, (image.height - cropHeight) / 2, cropWidth, cropHeight, x, y, width, height);
  }
  function renderSegmentationReview() {
    const canvas = segmentationEditor.canvas;
    if (!canvas || !segmentationPreviewPhoto) return;
    const review = document.createElement('canvas');
    review.width = 790;
    review.height = 284;
    const context = review.getContext('2d');
    context.fillStyle = '#faf8f2';
    context.fillRect(0, 0, review.width, review.height);
    const source = segmentationEditor.sourceImage || ui.photo;
    const panels = [{ x: 0, label: 'Source', background: null }, { x: 200, label: 'Warm BG', background: '#f4eee0' }, { x: 400, label: 'Blue BG', background: '#b9d7ee' }, { x: 600, label: 'Dark BG', background: '#252930' }];
    context.textAlign = 'center';
    context.font = '12px Georgia, serif';
    panels.forEach((panel) => {
      context.fillStyle = '#5a5042';
      context.fillText(panel.label, panel.x + 95, 16);
      if (panel.background) {
        context.fillStyle = panel.background;
        context.fillRect(panel.x, 25, 190, 254);
      }
      const image = panel.background ? canvas : source;
      const scale = Math.min(190 / image.width, 254 / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, panel.x + (190 - width) / 2, 25 + (254 - height) / 2, width, height);
    });
    byId('segmentation-review').src = review.toDataURL('image/jpeg', 0.94);
    byId('segmentation-download').href = canvas.toDataURL('image/png');
    byId('segmentation-download-original').href = originalCandidateDataUrl();
    updateSegmentationQuality();
  }
  function updateSegmentationQuality() {
    const canvas = segmentationEditor.canvas;
    const pixels = canvas?.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels?.length) return;
    let covered = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] >= 128) covered += 1;
    const coverage = covered / (pixels.length / 4) * 100;
    const band = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.01));
    const opaqueAt = (x, y) => pixels[(y * canvas.width + x) * 4 + 3] >= 240;
    const edgeCoverage = { left: 0, right: 0, top: 0, bottom: 0 };
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < band; x += 1) {
        if (opaqueAt(x, y)) edgeCoverage.left += 1;
        if (opaqueAt(canvas.width - 1 - x, y)) edgeCoverage.right += 1;
      }
    }
    for (let y = 0; y < band; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (opaqueAt(x, y)) edgeCoverage.top += 1;
        if (opaqueAt(x, canvas.height - 1 - y)) edgeCoverage.bottom += 1;
      }
    }
    edgeCoverage.left = edgeCoverage.left / (canvas.height * band) * 100;
    edgeCoverage.right = edgeCoverage.right / (canvas.height * band) * 100;
    edgeCoverage.top = edgeCoverage.top / (canvas.width * band) * 100;
    edgeCoverage.bottom = edgeCoverage.bottom / (canvas.width * band) * 100;
    const sideLabels = { left: '左侧', right: '右侧', top: '上沿', bottom: '下沿' };
    const sides = Object.keys(sideLabels).filter((side) => edgeCoverage[side] >= 2);
    const originalSides = Array.isArray(segmentationEditor.edgeReview?.possibleCropSides)
      ? segmentationEditor.edgeReview.possibleCropSides.filter((side) => sideLabels[side]) : [];
    const warnings = [];
    if (sides.length) warnings.push(`当前透明主体在${sides.map((side) => sideLabels[side]).join('、')}触边，原图可能裁断主体`);
    if (segmentationEditor.changed && originalSides.length && !sides.length)
      warnings.push(`原模型候选曾在${originalSides.map((side) => sideLabels[side]).join('、')}触边；当前蒙版已离开画框，但修边不能补回画外身体`);
    if (coverage < 10) warnings.push('前景覆盖偏少，可能只保留了局部或漏掉主体');
    else if (coverage > 98) warnings.push('前景覆盖几乎整张照片，可能没有充分去除背景');
    if (segmentationEditor.regionReview?.possibleExtraForeground)
      warnings.push(`模型候选有 ${segmentationEditor.regionReview.significantRegionCount} 块分离的大面积前景，可能混入人物或物件；请检查并修整，打包时会重新核验`);
    const promptReview = segmentationEditor.promptReview;
    const missedForeground = promptReview?.foregroundPointMissedIndices || [];
    const retainedBackground = promptReview?.backgroundPointForegroundIndices || [];
    if (missedForeground.length) warnings.push(`蒙版未覆盖 ${missedForeground.length}/${promptReview.foregroundPointCount} 个前景点附近`);
    if (retainedBackground.length) warnings.push(`蒙版仍覆盖 ${retainedBackground.length}/${promptReview.backgroundPointCount} 个背景点附近`);
    const coverageLabel = `蒙版覆盖约 ${coverage.toFixed(2)}%（alpha ≥ 128）`;
    const qualityText = warnings.length
      ? `检查提醒：${warnings.join('；')}。${coverageLabel}。此为像素启发式，不判断主体身份、遮挡或边缘质量；请对照原图检查。`
      : `画框边缘和蒙版面积初检未触发明显警示。${coverageLabel}。这不代表质量通过；分割或细化候选不会补回画外身体，也不判断木架遮挡。请对照原图检查轮廓、颜色与边缘。`;
    byId('segmentation-quality').textContent = qualityText;
  }
  async function selectSegmentationVariant(variant, requestPhoto) {
    segmentationCandidateRevision += 1;
    clearPortraitFraming();
    clearSegmentationPackageLink();
    await initializeSegmentationEditor(requestPhoto, variant.pngBase64, variant.alphaEdgeReview, variant.foregroundRegionReview, variant.promptReview, `SAM 2 候选 ${variant.index + 1} · 模型排序分数 ${Number(variant.score).toFixed(3)}；分数不代表人工质量批准。`);
    byId('segmentation-variants').querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.variantIndex) === variant.index));
    });
    byId('segmentation-edit-status').textContent = segmentationEditor.candidateLabel;
    renderActionSuitability();
  }
  function originalCandidateDataUrl() {
    if (!segmentationEditor.originalPixels) return '';
    const original = document.createElement('canvas');
    original.width = segmentationEditor.canvas.width;
    original.height = segmentationEditor.canvas.height;
    original.getContext('2d').putImageData(segmentationEditor.originalPixels, 0, 0);
    return original.toDataURL('image/png');
  }
  async function initializeSegmentationEditor(photo, pngBase64, edgeReview = null, regionReview = null, promptReview = null, candidateLabel = '', keepMatteComparison = false, isCurrent = () => true) {
    const candidateImage = await imageFromSource(`data:image/png;base64,${pngBase64}`);
    const sourceImage = await imageFromSource(photo);
    if (!isCurrent()) throw new Error('素材已变化，请重新生成细化候选。');
    if (!keepMatteComparison) clearMatteComparison();
    if (!keepMatteComparison) segmentationEditor.matteReport = null;
    const canvas = byId('segmentation-canvas');
    canvas.width = candidateImage.naturalWidth;
    canvas.height = candidateImage.naturalHeight;
    canvas.style.width = '100%';
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height || canvas.width * canvas.height > 24_000_000) throw new Error('候选图像尺寸不符合本机修整限制。');
    context.drawImage(candidateImage, 0, 0);
    const original = context.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = canvas.width;
    sourceCanvas.height = canvas.height;
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sourceContext.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    segmentationEditor.canvas = canvas;
    segmentationEditor.sourceImage = sourceImage;
    segmentationEditor.originalPixels = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    segmentationEditor.sourcePixels = sourceContext.getImageData(0, 0, canvas.width, canvas.height);
    segmentationEditor.edgeReview = edgeReview;
    segmentationEditor.regionReview = regionReview;
    segmentationEditor.promptReview = promptReview;
    segmentationEditor.candidateLabel = candidateLabel;
    segmentationEditor.undo = [];
    segmentationEditor.changed = false;
    segmentationEditor.mode = 'erase';
    segmentationEditor.activeStroke = null;
    segmentationEditor.lastPoint = null;
    document.querySelectorAll('[data-mask-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.maskMode === 'erase')));
    byId('segmentation-brush').value = '36';
    byId('segmentation-brush-size').value = '36 px';
    byId('segmentation-brush-size').textContent = '36 px';
    byId('segmentation-zoom').value = '100';
    byId('segmentation-zoom-value').value = '100%';
    byId('segmentation-zoom-value').textContent = '100%';
    byId('segmentation-edit-status').textContent = '尚未修改';
    byId('segmentation-undo').disabled = true;
    renderSegmentationReview();
  }
  byId('matte-refine').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = byId('matte-refine-status');
    const canvas = segmentationEditor.canvas;
    if (!canvas || byId('segmentation-result').hidden) return;
    const photo = segmentationPreviewPhoto;
    const revision = segmentationCandidateRevision;
    const isCurrent = () => photo === segmentationPreviewPhoto && revision === segmentationCandidateRevision && !byId('segmentation-result').hidden;
    const seed = canvas.toDataURL('image/png').split(',')[1];
    const original = { pngBase64: seed, edge: segmentationEditor.edgeReview, region: segmentationEditor.regionReview, prompt: segmentationEditor.promptReview, label: segmentationEditor.candidateLabel };
    const source = document.createElement('canvas');source.width = canvas.width;source.height = canvas.height;
    source.getContext('2d').drawImage(segmentationEditor.sourceImage, 0, 0, canvas.width, canvas.height);
    const photoPngBase64 = source.toDataURL('image/png').split(',')[1];
    button.disabled = true;status.textContent = '正在本机生成毛边细化候选，当前素材保持不变……';
    try {
      const capabilities = await fetch('http://127.0.0.1:4181/api/capabilities', { signal: AbortSignal.timeout(4000) });
      const info = await capabilities.json();
      if (!capabilities.ok || info.ready !== true || info.route !== 'closed-form-matte-v1' || info.requiresHumanReview !== true || info.installable !== false || info.remoteNetworkUsed !== false || info.inputPersisted !== true) throw new Error('细化服务声明不符合预期。');
      if (!isCurrent()) throw new Error('素材已改变；未发送旧图。');
      const response = await fetch('http://127.0.0.1:4181/api/refine-matte', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoPngBase64, seedPngBase64: seed, inner: Number(byId('matte-inner').value), outer: Number(byId('matte-outer').value) }), signal: AbortSignal.timeout(180000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error === 'matting-busy' ? '本机正在处理另一份候选，请稍后重试。' : data.detail || data.error);
      if (!isCurrent()) throw new Error('素材已改变，旧细化结果未应用；本机记录保留。');
      const report = data.report;
      if (data.status !== 'candidate-requires-human-review' || typeof data.foregroundPngBase64 !== 'string' || report?.approved !== false || report?.installable !== false || report?.remoteNetworkUsed !== false || !/^[a-f0-9]{32}$/.test(report?.candidateId || '')) throw new Error('细化候选或审核状态无效。');
      matteComparison = { photo, revision, original, refined: data.foregroundPngBase64, report };
      byId('matte-comparison').hidden = false;
      byId('matte-use-original').setAttribute('aria-pressed', 'true');byId('matte-use-refined').setAttribute('aria-pressed', 'false');
      byId('matte-report').href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2));
      status.textContent = `细化候选已保存 · ${report.processingDimensions.join(' × ')} · ${report.seconds} 秒。当前仍使用原蒙版，请切换检查耳尖、脚爪和毛边；细化可能丢失细毛或混入背景，不能视作审核通过。`;
    } catch (error) {
      if (isCurrent()) status.textContent = error instanceof TypeError ? '未连接本机毛边细化服务。当前蒙版保留；可按 tools/README.md 启动可选服务。' : `未应用细化：${error.message}`;
    } finally { button.disabled = false; }
  });
  for (const refined of [false, true]) byId(refined ? 'matte-use-refined' : 'matte-use-original').addEventListener('click', async () => {
    const comparison = matteComparison;
    const isCurrent = () => comparison === matteComparison && comparison.photo === segmentationPreviewPhoto && comparison.revision === segmentationCandidateRevision && !byId('segmentation-result').hidden;
    if (!comparison || !isCurrent()) { clearMatteComparison();byId('matte-refine-status').textContent = '蒙版已被修改，请重新生成比较；当前修改保留。';return; }
    const item = comparison.original;
    try {
      // Keep original crop/prompt warnings: alpha refinement cannot repair missing anatomy.
      await initializeSegmentationEditor(comparison.photo, refined ? comparison.refined : item.pngBase64, item.edge,
        refined ? comparison.report.foregroundRegionReview : item.region, item.prompt,
        refined ? '毛边细化候选 · 需逐背景检查 · 不补全身体' : item.label, true, isCurrent);
      segmentationCandidateRevision += 1;comparison.revision = segmentationCandidateRevision;
      segmentationEditor.matteReport = refined ? comparison.report : null;
      clearPortraitFraming();clearSegmentationPackageLink();renderActionSuitability();
      byId('matte-use-original').setAttribute('aria-pressed', String(!refined));byId('matte-use-refined').setAttribute('aria-pressed', String(refined));
      byId('matte-refine-status').textContent = refined
        ? '当前使用毛边细化候选，尚未审核。请在暖色、蓝色和深色背景上检查耳尖、脚爪与毛边；可随时切回细化前蒙版。'
        : '已恢复细化前蒙版。细化候选与来源记录仍保留，可继续比较；当前素材尚未审核。';
      byId('segmentation-edit-status').textContent = segmentationEditor.candidateLabel;
      byId('segmentation-variants').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', 'false'));
    } catch (error) { byId('matte-refine-status').textContent = `未切换：${error.message}`; }
  });
  function segmentationCanvasPoint(event) {
    const rect = segmentationEditor.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * segmentationEditor.canvas.width / rect.width, y: (event.clientY - rect.top) * segmentationEditor.canvas.height / rect.height };
  }
  function applySegmentationBrush(point) {
    const canvas = segmentationEditor.canvas;
    const radius = Number(byId('segmentation-brush').value);
    const left = Math.max(0, Math.floor(point.x - radius));
    const top = Math.max(0, Math.floor(point.y - radius));
    const right = Math.min(canvas.width, Math.ceil(point.x + radius));
    const bottom = Math.min(canvas.height, Math.ceil(point.y + radius));
    if (right <= left || bottom <= top) return;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const patch = context.getImageData(left, top, right - left, bottom - top);
    segmentationEditor.activeStroke.push({ x: left, y: top, image: new ImageData(new Uint8ClampedArray(patch.data), patch.width, patch.height) });
    const feather = Math.max(2, radius * 0.24);
    for (let y = 0; y < patch.height; y++) {
      const sourceY = top + y;
      for (let x = 0; x < patch.width; x++) {
        const sourceX = left + x;
        const distance = Math.hypot(sourceX + 0.5 - point.x, sourceY + 0.5 - point.y);
        if (distance >= radius) continue;
        const strength = Math.min(1, (radius - distance) / feather);
        const offset = (y * patch.width + x) * 4;
        const sourceOffset = (sourceY * canvas.width + sourceX) * 4;
        const alpha = patch.data[offset + 3] / 255;
        patch.data[offset] = segmentationEditor.sourcePixels.data[sourceOffset];
        patch.data[offset + 1] = segmentationEditor.sourcePixels.data[sourceOffset + 1];
        patch.data[offset + 2] = segmentationEditor.sourcePixels.data[sourceOffset + 2];
        patch.data[offset + 3] = Math.round((segmentationEditor.mode === 'erase' ? alpha * (1 - strength) : alpha + (1 - alpha) * strength) * 255);
      }
    }
    context.putImageData(patch, left, top);
  }
  function finishSegmentationStroke() {
    if (!segmentationEditor.activeStroke) return;
    if (segmentationEditor.activeStroke.length) {
      segmentationCandidateRevision += 1;
      clearPortraitFraming();
      clearSegmentationPackageLink();
      segmentationEditor.undo.push(segmentationEditor.activeStroke);
      if (segmentationEditor.undo.length > 20) segmentationEditor.undo.shift();
      segmentationEditor.changed = true;
      byId('segmentation-edit-status').textContent = `已修整 · ${segmentationEditor.undo.length} 次可撤销`;
      byId('segmentation-undo').disabled = false;
      renderSegmentationReview();
      renderActionSuitability();
    }
    segmentationEditor.activeStroke = null;
    segmentationEditor.lastPoint = null;
  }
  function isLocalPhoto(source) {
    return source === fallbackPhoto || (typeof source === 'string' && source.length <= 11_200_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source));
  }
  function setMode(next, announce = true) {
    const modeChanged = mode !== next;
    mode = next;
    document.querySelectorAll('.mode-option').forEach((button) => button.classList.toggle('selected', button.dataset.mode === next));
    byId('dialog-subtitle').textContent = next === 'real' ? '一只真实宠物 · 特征由你确认' : '一位原创角色 · 外观由你决定';
    byId('traits-title').firstChild.textContent = next === 'real' ? '从照片中能看到的特征 ' : '想从照片里保留哪些特征 ';
    byId('trait-note').textContent = next === 'real' ? '只记录照片中能确认的部分。被遮挡的身体区域不会自动补全。' : '原创角色可以从照片借鉴灵感；勾选你想保留的特征即可。';
    const prompt = byId('prompt-input');
    if (isDefaultPrompt(prompt.value.trim()) || !prompt.value.trim()) prompt.value = defaultPromptFor(next, currentAction);
    if (modeChanged) document.querySelectorAll('.trait-list input').forEach((box) => { box.checked = next === 'real' && photoSource === fallbackPhoto; });
    byId('workshop-chip').textContent = next === 'real' ? '真实宠物 · 身份保护开启' : '原创角色 · 设定由你掌控';
    byId('plan-description').textContent = next === 'real' ? '局部表情 · 保留身份特征 · 透明背景 · 低幅动作' : '局部表情 · 角色一致性 · 透明背景 · 低幅动作';
    setSourceEvidence(sourceEvidence);
    if (announce) tell(next === 'real' ? '已切换为真实宠物模式，身份特征将由你确认。' : '已切换为原创角色模式，可以自由设定外观。');
    persistDraft();
  }
  function setAction(next, announce = true) {
    invalidateAiPlan();
    const detached = activeReviewCandidate && activeReviewCandidate.action !== next;
    if (detached) activeReviewCandidate = null;
    const prompt = byId('prompt-input');
    if (isDefaultPrompt(prompt.value.trim())) prompt.value = defaultPromptFor(mode, next);
    currentAction = next;
    byId('wan-use').disabled = !wanChecksComplete();
    byId('workshop-to-video').textContent = next === '眨眨眼' ? '从照片或锚图试做动作' : '用锚图或已有视频制作此动作';
    renderActionSuitability();
    refreshPromptPlanPreview();
    if (photoWinkCandidate && next !== '眨眨眼') {
      photoWinkCandidate = null;
      byId('photo-wink-result').hidden = true;
      byId('photo-wink-status').textContent = '当前本机模板只支持眨眼；请选择眨眼或改用已有视频。';
    }
    if (portraitHistoryLoaded) renderPortraitHistory();
    document.querySelectorAll('.action-choice').forEach((button) => button.classList.toggle('active', button.dataset.action === next));
    renderWorkshopCandidate();
    if (announce) tell(detached ? `已选择「${next}」；旧候选属于另一个动作，已从角色草稿移除。` : `已选择「${next}」，动作素材生成后仍需逐帧审核。`);
    persistDraft();
  }
  function persistDraft() {
    try {
      const current = currentProfile();
      localStorage.setItem('littleOrbit.draft', JSON.stringify(current));
      if (editingCharacterId) localStorage.setItem('littleOrbit.draftCharacterId', editingCharacterId);
      else localStorage.removeItem('littleOrbit.draftCharacterId');
    } catch { /* Keep the workflow usable in private browsing or when storage is full. */ }
  }
  function estimatePhotoDetail(image) {
    if (!image || !image.naturalWidth || !image.naturalHeight) return null;
    try {
      const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(3, Math.round(image.naturalWidth * scale));
      const height = Math.max(3, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const gray = new Float32Array(width * height);
      for (let i = 0, pixel = 0; pixel < gray.length; pixel += 1, i += 4) {
        gray[pixel] = (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) * (pixels[i + 3] / 255);
      }
      let sum = 0, sumSquares = 0, count = 0;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const i = y * width + x;
          const edge = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
          sum += edge;
          sumSquares += edge * edge;
          count += 1;
        }
      }
      return Math.max(0, sumSquares / count - (sum / count) ** 2);
    } catch { return null; }
  }
  function checkPhoto(width, height, bytes, image = null) {
    const adequate = width >= 320 && height >= 320;
    const detailEstimate = estimatePhotoDetail(image);
    const possiblySoft = detailEstimate !== null && detailEstimate < 35;
    const accepted = adequate && !possiblySoft;
    ui.check.classList.toggle('warning', !accepted);
    ui.check.querySelector('.check-icon').textContent = accepted ? '✓' : '!';
    ui.check.querySelector('strong').textContent = !adequate
      ? '照片尺寸偏小，角色细节可能不清楚'
      : possiblySoft ? '图像边缘细节较少，请确认对焦情况' : '尺寸适合预览 · 边缘细节可辨';
    const detailLabel = detailEstimate === null ? '未能估算清晰度' : '清晰度本机估算，仅供参考';
    ui.check.querySelector('span').textContent = `${width} × ${height} px · ${(bytes / 1024).toFixed(0)} KB · ${detailLabel}`;
    byId('photo-caption-meta').textContent = `${width} × ${height} px · 本地照片 · 等待你确认特征`;
    byId('photo-caption-name').textContent = photoName;
    renderPhotoCoverageNotice();
    if (!adequate) tell('照片可以预览，但尺寸较小，建议换一张边长至少 640px 的清晰照片。');
  }
  function setSettingsForm(value = preferences) {
    byId('interaction-enabled').checked = value.interactionEnabled;
    byId('automatic-actions-enabled').checked = !!value.automaticActionsEnabled;
    byId('quiet-enabled').checked = value.quietEnabled;
    byId('quiet-start').value = value.quietStart;
    byId('quiet-end').value = value.quietEnd;
    byId('frequency-range').value = String(value.frequencyMinutes);
    byId('frequency-value').value = `每 ${value.frequencyMinutes} 分钟`;
    byId('frequency-value').textContent = `每 ${value.frequencyMinutes} 分钟`;
    byId('quiet-time-fields').classList.toggle('enabled', value.quietEnabled);
  }
  async function refreshLocalBackendStatus() {
    const card = byId('local-backend-status');
    const list = byId('backend-capability-list');
    const badge = byId('backend-status-badge');
    const button = byId('refresh-backend-status');
    card.dataset.state = 'checking';
    badge.textContent = '检查中';
    button.disabled = true;
    button.textContent = '检查中';
    const probes = [
      {
        url: `http://127.0.0.1:4174/api/capabilities?adapter=${byId('segmentation-backend').value}`,
        timeoutMs: 180000,
        label: '单图透明分割',
        validate: (value) => value.ready === true && ['birefnet-local', 'sam2-local'].includes(value.adapter) &&
          value.task === 'single-image-foreground-segmentation' && value.capabilities?.requiresHumanReview === true &&
          value.capabilities?.animationGeneration === false && value.privacy?.remoteNetworkUsed === false &&
          value.privacy?.inputPersisted === false && value.privacy?.temporaryOutputDeletedAfterResponse === true,
        describe: (value) => `${value.model} · 本机 · 输出待审核`,
      },
      {
        url: 'http://127.0.0.1:4175/api/capabilities',
        label: '视频透明预览',
        validate: (value) => value.ready === true && value.task === 'video-mask-propagation' &&
          value.capabilities?.requiresHumanReview === true && value.capabilities?.reviewDisposition === 'content-addressed-local-veto' &&
          value.privacy?.remoteNetworkUsed === false && value.privacy?.uploadedFramesPersisted === false,
        describe: (value) => `${value.model} · 本机 · 必须审核后再考虑安装`,
      },
      {
        url: 'http://127.0.0.1:4176/api/capabilities',
        label: '照片眨眼',
        validate: (value) => value.ready === true && value.task === 'photo-to-wink-video' && value.model === 'LivePortrait Animals v1.1' &&
          value.review?.required === true && value.review?.transparent === false && value.review?.installable === false &&
          value.privacy?.remoteNetworkUsed === false && value.licenseTerms?.sourceUrl === 'https://github.com/IDEA-Research/X-Pose/blob/master/LICENSE.txt' &&
          value.licenseTerms?.permittedUse === 'non-commercial scientific research' && value.licenseTerms?.nonTransferable === true &&
          value.licenseTerms?.nonSublicensable === true && value.privacy?.sourceImagePersisted === false &&
          ['commercial', 'pornographic', 'military', 'surveillance'].every((purpose) => value.licenseTerms?.prohibitedPurposes?.includes(purpose)),
        describe: (value) => `${value.model} · 仅限非商业科研确认 · 有背景待审视频`,
        restricted: true,
      },
      {
        url: 'http://127.0.0.1:4179/api/capabilities',
        label: '照片与锚图视频',
        validate: (value) => value.ready === true && value.task === 'reference-and-rgba-anchor-to-rgb-video' &&
          value.model === 'Wan 2.2 TI2V-5B fp16' && value.species?.includes('cat') && value.species?.includes('dog') &&
          value.requiresSeparateRgbaAnchor === true && value.modelFilesVerifiedOnGeneration === true &&
          value.review?.required === true && value.review?.transparent === false && value.review?.installable === false &&
          value.privacy?.remoteNetworkUsed === false && value.privacy?.sourceImagesPersisted === true &&
          value.privacy?.candidateOutputsPersisted === true,
        describe: (value) => `${value.model} · 本机 · 需另备透明锚图 · RGB 视频待审核`,
      },
    ];
    const results = await Promise.all(probes.map(async (probe) => {
      try {
        const response = await fetch(probe.url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(probe.timeoutMs || 3500) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json();
        if (!probe.validate(value)) return { label: probe.label, state: 'blocked', detail: '服务未就绪或能力/隐私/审核声明不符合要求。' };
        return { label: probe.label, state: probe.restricted ? 'restricted' : 'ready', detail: probe.describe(value) };
      } catch {
        return { label: probe.label, state: 'offline', detail: '未连接；该任务当前不可用。' };
      }
    }));
    list.replaceChildren(...results.map((result) => {
      const item = document.createElement('li');
      item.dataset.state = result.state;
      item.textContent = `${result.label}：${result.detail}`;
      return item;
    }));
    const usableCount = results.filter((result) => result.state === 'ready').length;
    const researchAvailable = results.some((result) => result.state === 'restricted');
    card.dataset.state = usableCount ? 'ready' : 'offline';
    badge.textContent = usableCount ? `${usableCount} 项可用` : researchAvailable ? '科研受限' : '未连接';
    button.disabled = false;
    button.textContent = '重新检查';
  }
  function readSettingsForm() {
    return { interactionEnabled: byId('interaction-enabled').checked,
      automaticActionsEnabled: byId('automatic-actions-enabled').checked, quietEnabled: byId('quiet-enabled').checked,
      quietStart: byId('quiet-start').value || '22:00', quietEnd: byId('quiet-end').value || '08:00',
      frequencyMinutes: Number(byId('frequency-range').value) || 15 };
  }
  function isQuietNow() {
    if (!preferences.quietEnabled) return false;
    const toMinutes = (time) => { const [hours, minutes] = time.split(':').map(Number); return hours * 60 + minutes; };
    const start = toMinutes(preferences.quietStart), end = toMinutes(preferences.quietEnd);
    if (start === end) return false;
    const now = new Date(), current = now.getHours() * 60 + now.getMinutes();
    return start < end ? current >= start && current < end : current >= start || current < end;
  }
  function currentProfile() {
    const checks = [...document.querySelectorAll('.trait-list input:checked')].map((input) => traitLabelText(input.parentElement));
    return { name: ui.name.value.trim() || '小伙伴', mode, photo: photoSource, photoName, referencePhotos: normalizeReferencePhotos(referencePhotos), action: currentAction, prompt: byId('prompt-input').value.trim(), traits: normalizeTraits(checks), sourceEvidence: normalizeSourceEvidence(sourceEvidence, photoSource, referencePhotos), photoReview: normalizePhotoReview(photoReview), reviewCandidate: candidateReviewIssue(activeReviewCandidate?.id) ? null : normalizeRoleCandidate(activeReviewCandidate) };
  }
  function traitLabelText(label) {
    return [...label.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim();
  }
  function normalizeTraits(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values
      .filter((value) => typeof value === 'string')
      .map((value) => value.replace(/^[✓\s]+/u, '').trim())
      .filter((value) => knownTraits.includes(value)))];
  }
  function updateCharacterCount() {
    const count = String(savedCharacters.length).padStart(2, '0');
    byId('character-count').textContent = count;
    byId('archive-count').textContent = savedCharacters.length ? `本地角色 · ${count}` : '还没有本地角色';
  }
  function sameEditableProfile(left, right) {
    return editableSnapshot(left) === editableSnapshot(right);
  }
  async function saveCharacter() {
    const existing = savedCharacters.find((item) => item.id === editingCharacterId) || null;
    const now = new Date().toISOString();
    const edits = currentProfile();
    const changed = !existing || !sameEditableProfile(existing, edits);
    const id = existing?.id || newCharacterId();
    let profile;
    let storedVersionIds = [];
    let prunedVersionIds = [];
    if (existing && changed) {
      try {
        const compacted = await compactRoleHistory(id, existing.versionHistory);
        let history = compacted.history;
        prunedVersionIds.push(...compacted.removed);
        if (existing.previousVersion) {
          const migrated = await archiveUniqueRoleVersion(id, existing.previousVersion, history);
          if (migrated.created) storedVersionIds.push(migrated.entry.id);
          history = [migrated.entry, ...history.filter((entry) => entry.id !== migrated.entry.id)];
        }
        const snapshot = await archiveUniqueRoleVersion(id, roleVersion(existing), history);
        if (snapshot.created) storedVersionIds.push(snapshot.entry.id);
        history = [snapshot.entry, ...history.filter((entry) => entry.id !== snapshot.entry.id)];
        if (history.length > maxRoleVersions) {
          prunedVersionIds.push(...history.slice(maxRoleVersions).map((entry) => entry.id));
          history = history.slice(0, maxRoleVersions);
        }
        profile = normalizeCharacter({ ...edits, id, createdAt: existing.createdAt || now,
          updatedAt: now, versionHistory: history, previousVersion: null });
      } catch (error) {
        await deleteRoleVersions(storedVersionIds).catch(() => {});
        tell(`角色历史未能保存，本次修改没有覆盖当前版本：${error.message}`);
        return false;
      }
    } else {
      profile = normalizeCharacter({ ...edits, id, createdAt: existing?.createdAt || now,
        updatedAt: now, versionHistory: existing?.versionHistory || [], previousVersion: existing?.previousVersion || null });
    }
    const nextCharacters = existing
      ? savedCharacters.map((item) => item.id === existing.id ? profile : item)
      : [profile, ...savedCharacters];
    const draftKeys = ['littleOrbit.draft', 'littleOrbit.draftCharacterId', 'littleOrbit.character'];
    const preservedDraft = {};
    let draftCaptured = false;
    let persistenceCaptured = false;
    let cardPersisted = false;
    let previousCharacters = null;
    let previousActiveCharacterId = null;
    let previousPhotoCard = null;
    try {
      draftKeys.forEach((key) => { preservedDraft[key] = localStorage.getItem(key); });
      draftCaptured = true;
      previousCharacters = localStorage.getItem('littleOrbit.characters');
      previousActiveCharacterId = localStorage.getItem('littleOrbit.activeCharacterId');
      persistenceCaptured = true;
      previousPhotoCard = existing ? await readStoredCharacter(id) : null;
      await writeStoredCharacter(profile);
      cardPersisted = true;
      profile.photoStored = true;
      // A draft duplicates the same large data URL as the new card. Free it before
      // committing the card so the duplicate does not exhaust localStorage quota.
      draftKeys.forEach((key) => localStorage.removeItem(key));
      localStorage.setItem('littleOrbit.characters', serializeCharacterIndex(nextCharacters));
      localStorage.setItem('littleOrbit.activeCharacterId', profile.id);
      savedCharacters = nextCharacters;
      savedCharacter = profile;
      editingCharacterId = profile.id;
      updateCharacterCount();
      renderCharacterLibrary();
      if (prunedVersionIds.length) deleteRoleVersions(prunedVersionIds).catch(() => {});
      setPetTitle(profile.name);
      byId('pet-dialog-foot').textContent = profile.reviewCandidate
        ? '角色卡已保存 · 动作候选仍待审核，桌面保持静态照片回退'
        : '角色卡已保存 · 尚无可用动作素材，桌面保持静态照片回退';
      return true;
    } catch {
      const restoreStorageValue = (key, value) => {
        try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
        catch { /* Keep the original save error if storage is full. */ }
      };
      if (persistenceCaptured) {
        restoreStorageValue('littleOrbit.characters', previousCharacters);
        restoreStorageValue('littleOrbit.activeCharacterId', previousActiveCharacterId);
      }
      if (draftCaptured) draftKeys.forEach((key) => restoreStorageValue(key, preservedDraft[key]));
      if (cardPersisted) {
        if (previousPhotoCard) await writeStoredCharacter(previousPhotoCard).catch(() => {});
        else await deleteStoredCharacter(id).catch(() => {});
      }
      await deleteRoleVersions(storedVersionIds).catch(() => {});
      tell('本地存储空间不足，角色卡暂未保存；可改用小一些的照片。');
      return false;
    }
  }
  function renderCharacterLibrary() {
    const library = byId('character-library');
    const empty = byId('collection-empty');
    const grid = byId('character-grid');
    grid.replaceChildren();
    grid.classList.toggle('single-character', savedCharacters.length === 1);
    if (!savedCharacters.length) {
      library.hidden = true;
      empty.hidden = false;
      updateCharacterCount();
      return;
    }
    library.hidden = false;
    empty.hidden = true;
    const template = byId('character-card-template');
    savedCharacters.forEach((profile) => {
      const card = template.content.firstElementChild.cloneNode(true);
      const name = profile.name || '小伙伴';
      const image = card.querySelector('[data-role="photo"]');
      image.src = isLocalPhoto(profile.photo) ? profile.photo : fallbackPhoto;
      image.alt = `${name}的角色卡照片`;
      card.querySelector('[data-role="mode"]').textContent = profile.mode === 'original' ? '原创角色 · 创作锚点' : '真实宠物 · 身份锚点';
      card.querySelector('[data-role="source-evidence"]').textContent = profile.sourceEvidence.includes('fullSilhouette')
        ? '照片完整轮廓：由用户确认 · 动作素材仍待审核'
        : '照片未确认完整轮廓 · 全身生成需标为推断版本';
      if (profile.referencePhotos.length) card.querySelector('[data-role="source-evidence"]').textContent += ` · 另有 ${profile.referencePhotos.length} 张视角`;
      const photoReviewState = normalizePhotoReview(profile.photoReview);
      const subjectLabel = { one: '一只', multiple: '多只', uncertain: '不确定' }[photoReviewState.subjectCount];
      const occlusionLabel = { clear: '未发现遮挡', present: '有遮挡/裁切', uncertain: '遮挡不确定' }[photoReviewState.occlusion];
      card.querySelector('[data-role="source-evidence"]').textContent += ` · 人工检查：${subjectLabel}宠物 · ${occlusionLabel}`;
      card.querySelector('[data-role="name"]').textContent = name;
      const traitList = card.querySelector('[data-role="traits"]');
      const traits = normalizeTraits(profile.traits);
      if (traits.length) {
        traits.forEach((trait) => {
          const item = document.createElement('li');
          item.textContent = trait;
          traitList.append(item);
        });
      } else {
        const item = document.createElement('li');
        item.className = 'trait-empty';
        item.textContent = '还没有确认可见特征';
        traitList.append(item);
      }
      card.querySelector('[data-role="action"]').textContent = profile.action || '尚未选择';
      card.querySelector('[data-role="prompt"]').textContent = profile.prompt ? profile.prompt.trim().slice(0, 180) : '还没有填写动作描述。';
      card.querySelector('[data-role="runtime-status"]').lastChild.textContent = profile.reviewCandidate && candidateReviewIssue(profile.reviewCandidate.id)
        ? `关联候选需修改：${videoReviewIssues[candidateReviewIssue(profile.reviewCandidate.id)]} · 未安装`
        : profile.reviewCandidate
        ? `已关联 ${profile.reviewCandidate.frameCount} 帧待审候选 · 未安装`
        : '动作素材尚未生成';
      const versionCount = normalizeRoleHistory(profile.versionHistory).length + (profile.previousVersion ? 1 : 0);
      card.querySelector('[data-role="version-status"]').textContent = versionCount ? `${versionCount} 个可恢复版本` : '尚无旧版本';
      card.querySelectorAll('[data-action="preview"]').forEach((button) => button.addEventListener('click', () => openSavedCharacterPreview(profile)));
      card.querySelector('[data-action="edit"]').addEventListener('click', () => editSavedCharacter(profile));
      card.querySelector('[data-action="restore-version"]').disabled = versionCount === 0;
      card.querySelector('[data-action="restore-version"]').textContent = '版本历史';
      card.querySelector('[data-action="restore-version"]').addEventListener('click', () => openRoleHistory(profile));
      grid.append(card);
    });
    updateCharacterCount();
  }
  let rollbackCharacterId = null;
  let selectedRoleVersion = null;
  async function openRoleHistory(profile) {
    if (!profile) { tell('这张角色卡还没有可恢复的旧版本。'); return; }
    const draftId = (() => { try { return localStorage.getItem('littleOrbit.draftCharacterId'); } catch { return null; } })();
    if (draftId === profile.id) {
      let draft = null;
      try { draft = JSON.parse(localStorage.getItem('littleOrbit.draft') || 'null'); } catch { /* Ignore an unreadable draft. */ }
      if (draft && !sameEditableProfile(draft, profile)) {
        tell('这张角色卡还有未保存的修改。请先保存或放弃修改，再恢复旧版本。');
        return;
      }
    }
    try {
      let prepared = profile;
      let history = normalizeRoleHistory(profile.versionHistory);
      if (profile.previousVersion && !history.length) {
        const migrated = await storeRoleVersion(profile.id, profile.previousVersion);
        history = [migrated];
        prepared = normalizeCharacter({ ...profile, previousVersion: null, versionHistory: history });
        const next = savedCharacters.map((item) => item.id === profile.id ? prepared : item);
        try { localStorage.setItem('littleOrbit.characters', serializeCharacterIndex(next)); }
        catch (error) { await deleteRoleVersions([migrated.id]).catch(() => {}); throw error; }
        savedCharacters = next;
        if (savedCharacter?.id === profile.id) savedCharacter = prepared;
      }
      const compacted = await compactRoleHistory(prepared.id, prepared.versionHistory);
      history = compacted.history;
      if (compacted.removed.length) {
        prepared = normalizeCharacter({ ...prepared, versionHistory: history });
        const next = savedCharacters.map((item) => item.id === prepared.id ? prepared : item);
        localStorage.setItem('littleOrbit.characters', serializeCharacterIndex(next));
        savedCharacters = next;
        if (savedCharacter?.id === prepared.id) savedCharacter = prepared;
        renderCharacterLibrary();
        deleteRoleVersions(compacted.removed).catch(() => {});
      }
      if (!history.length) { tell('这张角色卡还没有可恢复的历史版本。'); return; }
      rollbackCharacterId = prepared.id;
      selectedRoleVersionId = '';
      selectedRoleVersion = null;
      const list = byId('role-history-list');
      list.replaceChildren();
      history.forEach((entry, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'role-history-entry';
        button.dataset.versionId = entry.id;
        const title = document.createElement('strong');
        title.textContent = `版本 ${history.length - index} · ${entry.name}`;
        const meta = document.createElement('small');
        const when = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '时间未知';
        meta.textContent = `${when} · ${entry.action} · ${entry.photoName}`;
        button.append(title, meta);
        button.addEventListener('click', () => selectRoleHistoryVersion(entry.id));
        list.append(button);
      });
      byId('role-rollback-intro').textContent = `本地保留最近 ${history.length} 个角色版本。选中一版检查照片和动作后，再确认恢复。`;
      byId('role-rollback-confirmed').checked = false;
      byId('confirm-role-rollback').disabled = true;
      byId('role-rollback-dialog').showModal();
      await selectRoleHistoryVersion(history[0].id);
    } catch (error) {
      tell(`无法打开角色版本历史：${error.message}`);
    }
  }
  async function selectRoleHistoryVersion(versionId) {
    const buttons = [...byId('role-history-list').querySelectorAll('.role-history-entry')];
    buttons.forEach((button) => button.classList.toggle('selected', button.dataset.versionId === versionId));
    selectedRoleVersionId = versionId;
    selectedRoleVersion = null;
    byId('role-rollback-confirmed').checked = false;
    byId('confirm-role-rollback').disabled = true;
    try {
      const candidate = await readRoleVersion(versionId, rollbackCharacterId);
      if (!candidate || versionId !== selectedRoleVersionId) return;
      selectedRoleVersion = candidate;
      byId('role-rollback-image').src = candidate.photo;
      byId('role-rollback-image').alt = `${candidate.name}历史版本照片`;
      byId('role-rollback-name').textContent = candidate.name;
      byId('role-rollback-mode').textContent = candidate.mode === 'original' ? '原创角色 · 创作锚点' : '真实宠物 · 身份锚点';
      byId('role-rollback-action').textContent = `动作：${candidate.action}`;
      byId('role-rollback-review-candidate').textContent = candidate.reviewCandidate && candidateReviewIssue(candidate.reviewCandidate.id)
        ? `关联候选已标记需修改：${videoReviewIssues[candidateReviewIssue(candidate.reviewCandidate.id)]}；恢复时会解除候选关联`
        : candidate.reviewCandidate
        ? `关联 ${candidate.reviewCandidate.frameCount} 帧待审候选 · ${candidate.reviewCandidate.id.slice(0, 8)} · 未批准、未安装`
        : '无关联动作候选；桌面使用静态照片回退';
      byId('role-rollback-intro').textContent = '核对历史照片和动作信息，勾选确认后才会替换当前角色卡。';
    } catch (error) {
      byId('role-rollback-intro').textContent = `此版本暂时无法读取：${error.message}`;
    }
  }
  async function restorePreviousRoleVersion() {
    if (!rollbackCharacterId || !selectedRoleVersionId || !selectedRoleVersion || !byId('role-rollback-confirmed').checked) return;
    const current = savedCharacters.find((profile) => profile.id === rollbackCharacterId);
    if (!current) { byId('role-rollback-dialog').close(); tell('角色卡已变化，请重新打开版本历史。'); return; }
    let currentEntry;
    let pruned = [];
    let restoredCardPersisted = false;
    let previousPhotoCard = null;
    try {
      previousPhotoCard = await readStoredCharacter(current.id);
      const archivedCurrent = await archiveUniqueRoleVersion(current.id, roleVersion(current), current.versionHistory);
      currentEntry = archivedCurrent.entry;
      const compacted = await compactRoleHistory(current.id, current.versionHistory);
      pruned = compacted.removed;
      let history = [currentEntry, ...compacted.history.filter((entry) => entry.id !== currentEntry.id)];
      if (history.length > maxRoleVersions) {
        pruned.push(...history.slice(maxRoleVersions).map((entry) => entry.id));
        history = history.slice(0, maxRoleVersions);
      }
      const restored = normalizeCharacter({ ...current, ...selectedRoleVersion,
        reviewCandidate: candidateReviewIssue(selectedRoleVersion.reviewCandidate?.id) ? null : selectedRoleVersion.reviewCandidate,
        id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString(),
        previousVersion: null, versionHistory: history });
      const nextCharacters = savedCharacters.map((profile) => profile.id === current.id ? restored : profile);
      const previousCharacters = localStorage.getItem('littleOrbit.characters');
      const previousActiveCharacterId = localStorage.getItem('littleOrbit.activeCharacterId');
      await writeStoredCharacter(restored);
      restoredCardPersisted = true;
      restored.photoStored = true;
      try {
        localStorage.setItem('littleOrbit.characters', serializeCharacterIndex(nextCharacters));
        localStorage.setItem('littleOrbit.activeCharacterId', restored.id);
      }
      catch (error) {
        try {
          if (previousCharacters === null) localStorage.removeItem('littleOrbit.characters');
          else localStorage.setItem('littleOrbit.characters', previousCharacters);
          if (previousActiveCharacterId === null) localStorage.removeItem('littleOrbit.activeCharacterId');
          else localStorage.setItem('littleOrbit.activeCharacterId', previousActiveCharacterId);
        } catch { /* Preserve the original write failure. */ }
        if (restoredCardPersisted) {
          if (previousPhotoCard) await writeStoredCharacter(previousPhotoCard).catch(() => {});
          else await deleteStoredCharacter(current.id).catch(() => {});
        }
        if (archivedCurrent.created) await deleteRoleVersions([currentEntry.id]).catch(() => {});
        throw error;
      }
      if (localStorage.getItem('littleOrbit.draftCharacterId') === restored.id) {
        localStorage.removeItem('littleOrbit.draft');
        localStorage.removeItem('littleOrbit.draftCharacterId');
      }
      savedCharacters = nextCharacters;
      savedCharacter = restored;
      rollbackCharacterId = null;
      selectedRoleVersionId = '';
      selectedRoleVersion = null;
      byId('role-rollback-dialog').close();
      renderCharacterLibrary();
      if (pruned.length) deleteRoleVersions(pruned).catch(() => {});
      tell(`已恢复「${restored.name}」；原当前版本已加入历史，可以再次切换。`);
    } catch (error) {
      tell(`角色版本未恢复，当前版本保持不变：${error.message}`);
    }
  }
  byId('role-rollback-dialog').addEventListener('close', () => {
    rollbackCharacterId = null;
    selectedRoleVersionId = '';
    selectedRoleVersion = null;
    byId('role-rollback-confirmed').checked = false;
    byId('confirm-role-rollback').disabled = true;
  });
  function openSavedCharacterPreview(profile = savedCharacter) {
    if (!profile) { tell('还没有保存的角色卡，先从一张照片开始吧。'); return; }
    savedCharacter = profile;
    try { localStorage.setItem('littleOrbit.activeCharacterId', profile.id); } catch { /* Preview remains available without storage. */ }
    updateImages(isLocalPhoto(profile.photo) ? profile.photo : fallbackPhoto);
    const name = profile.name || '小伙伴';
    setPetTitle(name);
    byId('pet-dialog-foot').textContent = profile.reviewCandidate && candidateReviewIssue(profile.reviewCandidate.id)
      ? '关联的动作候选已标记需修改，桌面保持静态照片回退'
      : profile.reviewCandidate
      ? '角色卡已保存 · 动作候选仍待审核，桌面保持静态照片回退'
      : '角色卡已保存 · 尚无可用动作素材，桌面保持静态照片回退';
    ui.petDialog.showModal();
  }
  function editSavedCharacter(profile = savedCharacter) {
    if (!profile) return;
    savedCharacter = profile;
    editingCharacterId = profile.id;
    ui.name.value = profile.name;
    mode = profile.mode;
    photoSource = profile.photo;
    photoName = profile.photoName;
    referencePhotos = normalizeReferencePhotos(profile.referencePhotos);
    renderReferencePhotos();
    setPhotoReview(profile.photoReview);
    setSourceEvidence(profile.sourceEvidence);
    currentAction = profile.action;
    activeReviewCandidate = candidateReviewIssue(profile.reviewCandidate?.id) ? null : normalizeRoleCandidate(profile.reviewCandidate);
    byId('prompt-input').value = profile.prompt;
    updateImages(photoSource);
    setMode(mode, false);
    setAction(currentAction, false);
    const savedTraits = normalizeTraits(profile.traits);
    document.querySelectorAll('.trait-list label').forEach((label) => {
      label.querySelector('input').checked = savedTraits.includes(traitLabelText(label));
    });
    ui.nameCount.textContent = `${ui.name.value.length} / 18`;
    byId('dialog-name').textContent = ui.name.value || '小伙伴';
    byId('workshop-heading').textContent = `给${ui.name.value || '小伙伴'}设计一个小动作`;
    setWorkshopPreviewName(ui.name.value);
    byId('photo-caption-name').textContent = photoName;
    persistDraft();
    document.querySelectorAll('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item.dataset.page === 'studio'));
    byId('studio-page').hidden = false;
    byId('characters-page').hidden = true;
    byId('breadcrumb-current').textContent = '创作空间';
    ui.creation.showModal();
  }
  function startNewCharacter() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem('littleOrbit.draft') || 'null'); } catch { /* Ignore invalid local drafts. */ }
    const draftId = (() => { try { return localStorage.getItem('littleOrbit.draftCharacterId'); } catch { return null; } })();
    const base = savedCharacters.find((profile) => profile.id === draftId);
    if (draft && (!base || !sameEditableProfile(draft, base))) {
      tell('还有一份未完成草稿。请先继续或保存它，再新建角色。');
      return;
    }
    try { localStorage.removeItem('littleOrbit.draft'); localStorage.removeItem('littleOrbit.draftCharacterId'); } catch { /* Start a new session in memory. */ }
    editingCharacterId = null;
    photoSource = fallbackPhoto;
    photoName = '在木架间发现一只小猫';
    referencePhotos = [];
    renderReferencePhotos();
    setPhotoReview(undefined);
    setSourceEvidence(['face', 'frontPaws']);
    mode = 'real';
    currentAction = '眨眨眼';
    activeReviewCandidate = null;
    ui.name.value = '小伙伴';
    byId('prompt-input').value = realPetPrompt;
    updateImages(photoSource);
    setMode('real', false);
    setAction('眨眨眼', false);
    document.querySelectorAll('.trait-list label').forEach((label) => { label.querySelector('input').checked = true; });
    ui.nameCount.textContent = `${ui.name.value.length} / 18`;
    byId('dialog-name').textContent = ui.name.value;
    byId('workshop-heading').textContent = `给${ui.name.value}设计一个小动作`;
    setWorkshopPreviewName(ui.name.value);
    byId('photo-caption-name').textContent = photoName;
    checkPhoto(1279, 1706, 455501, ui.photo);
    persistDraft();
    document.querySelectorAll('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item.dataset.page === 'studio'));
    byId('studio-page').hidden = false;
    byId('characters-page').hidden = true;
    byId('breadcrumb-current').textContent = '创作空间';
    ui.name.focus();
    tell('已准备新的本地角色草稿，先给它起个名字。');
  }

  ui.name.addEventListener('input', () => {
    ui.nameCount.textContent = `${ui.name.value.length} / 18`;
    byId('dialog-name').textContent = ui.name.value.trim() || '小伙伴';
    setWorkshopPreviewName(ui.name.value.trim() || '小伙伴');
    persistDraft();
  });
  document.querySelectorAll('.mode-option').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.querySelectorAll('.action-choice').forEach((button) => button.addEventListener('click', () => setAction(button.dataset.action)));
  document.querySelectorAll('[data-evidence-part]').forEach((input) => input.addEventListener('change', () => {
    setSourceEvidence([...document.querySelectorAll('[data-evidence-part]:checked')].map((item) => item.dataset.evidencePart));
    persistDraft();
  }));
  byId('prompt-input').addEventListener('input', () => {
    invalidateAiPlan(); refreshPromptPlanPreview();
    byId('wan-use').disabled = !wanChecksComplete();
    persistDraft();
  });
  document.querySelectorAll('.trait-list input').forEach((input) => input.addEventListener('change', invalidateAiPlan));
  byId('ai-plan-consent').addEventListener('change', (event) => {
    if (!event.currentTarget.checked) invalidateAiPlan();
    byId('ai-plan-run').disabled = !event.currentTarget.checked;
    if (event.currentTarget.checked) byId('ai-plan-status').textContent = '确认后才会发送文字；照片始终留在本机。';
  });
  byId('ai-plan-run').addEventListener('click', runAiPlan);
  byId('workshop-dialog').addEventListener('close', cancelAiPlan);
  byId('ai-wink-apply').addEventListener('click', () => {
    const plan = aiPlanRecord;
    if (!plan || JSON.stringify(aiPlanContext()) !== plan.contextKey || !byId('ai-plan-consent').checked ||
        ![1.25, 1.5, 1.75].includes(plan.multiplier) || currentAction !== '眨眨眼') {
      byId('ai-wink-apply-status').textContent = '计划或角色依据已经变化，请重新生成文字计划。';
      return;
    }
    const slider = byId('photo-wink-strength');
    slider.value = plan.multiplier.toFixed(2);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    aiWinkApplied = { planId: plan.id, promptSha256: plan.promptSha256,
      model: plan.model, motionIntensity: plan.motionIntensity,
      drivingMultiplier: plan.multiplier, contextKey: plan.contextKey };
    const note = byId('photo-wink-plan-note');
    note.hidden = false;
    note.textContent = `已应用 AI 计划建议的${{ subtle: '轻微', standard: '标准', expressive: '明显' }[plan.motionIntensity]}幅度 ${plan.multiplier.toFixed(2)}×；只改变本机固定眨眼驱动幅度，动作仍需逐帧审核。`;
    byId('ai-wink-apply-status').textContent = '幅度已写入本机生成参数；取景和动作文字没有自动改变。';
  });
  byId('ai-plan-apply').addEventListener('click', () => {
    const revised = byId('ai-plan-edit').value.trim();
    if (!revised || revised.length > 1200) {
      byId('ai-plan-status').textContent = '编辑后的计划需为 1–1200 字。';
      return;
    }
    byId('prompt-input').value = revised;
    byId('prompt-input').dispatchEvent(new Event('input', { bubbles: true }));
    byId('ai-plan-status').textContent = '已把编辑后的计划写入动作描述。固定眨眼模板不会执行自由文字；导入视频时请核对动作是否相符。';
  });
  byId('replace-photo').addEventListener('click', () => ui.photoInput.click());
  ui.photo.addEventListener('click', () => ui.photoInput.click());
  document.querySelectorAll('.photo-review input').forEach((input) => input.addEventListener('change', () => {
    setPhotoReview({
      subjectCount: document.querySelector('[name="review-subject"]:checked')?.value,
      occlusion: document.querySelector('[name="review-occlusion"]:checked')?.value,
    }, true);
  }));
  byId('segmentation-photo-source').addEventListener('change', () => {
    const selected = selectedSegmentationSource();
    resetSegmentationForPhotoChange(selected);
  });
  byId('segmentation-backend').addEventListener('change', (event) => {
    const sam2 = event.currentTarget.value === 'sam2-local';
    invalidateSegmentationCandidate();
    sam2PromptState.foreground = [];
    sam2PromptState.background = [];
    sam2PromptState.photo = selectedSegmentationSource().photo;
    byId('sam2-prompt').hidden = !sam2;
    byId('run-segmentation').querySelector('span').textContent = sam2 ? '引导分割 →' : '✦';
    byId('segmentation-status').textContent = `已切换到${sam2 ? ' SAM 2 点选引导' : ' BiRefNet 自动识别'}；旧候选已清除。${sam2 ? '请在照片上重新点选前景和背景。' : '可重新生成透明主体预览。'}`;
    if (sam2) renderSam2PromptCanvas();
  });
  document.querySelectorAll('[data-point-label]').forEach((button) => button.addEventListener('click', () => {
    sam2PromptState.mode = button.dataset.pointLabel;
    document.querySelectorAll('[data-point-label]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
  }));
  byId('sam2-canvas').addEventListener('click', (event) => {
    const canvas = event.currentTarget;
    if (!canvas.width || !canvas.height || sam2PromptState.photo !== selectedSegmentationSource().photo) return;
    const rect = canvas.getBoundingClientRect();
    const point = [
      Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width))),
      Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height))),
    ];
    const points = sam2PromptState[sam2PromptState.mode];
    if (sam2PromptState.foreground.length + sam2PromptState.background.length >= 32) return;
    points.push(point);
    invalidateSegmentationCandidate();
    byId('segmentation-status').textContent = '点选提示已更改；旧候选已清除，请重新运行分割。';
    renderSam2PromptCanvas();
  });
  byId('sam2-clear-points').addEventListener('click', () => {
    sam2PromptState.foreground = [];
    sam2PromptState.background = [];
    invalidateSegmentationCandidate();
    byId('segmentation-status').textContent = '点选已清除；旧候选已清除，请重新设置前景点后运行。';
    renderSam2PromptCanvas();
  });
  byId('segmentation-result').parentElement.insertAdjacentHTML('beforeend', `
    <section class="segmentation-editor head-tilt-workshop" aria-label="透明角色歪头制作">
      <h3>让透明角色歪头</h3>
      <p>身体保持原样，头部倾斜一次再回正。可手动选参数，或由 AI 把 Prompt 解释为下方参数。仅支持 4°/8°、2/3/4 秒的单向歪头，不会补画被裁掉的身体。</p>
      <label>动作 Prompt <textarea id="head-tilt-prompt" rows="3" maxlength="1200">保留原有脸部和花纹，缓慢向左歪头，然后自然回正。</textarea></label>
      <label>参数来源 <select id="head-tilt-planning"><option value="manual">手动参数（文字仅记录）</option><option value="ai">AI 解释 Prompt（受限动作模板）</option></select></label>
      <label><input id="head-tilt-ai-consent" type="checkbox">允许通过本机 Codex CLI 向 OpenAI 发送此动作文字；不发送照片</label>
      <button id="head-tilt-ai-run" class="secondary-button" type="button" disabled>解释 Prompt 并应用参数</button>
      <p id="head-tilt-ai-status" role="status">手动模式只执行所选参数。AI 模式需要先解释当前描述，不支持的动作不会转成歪头候选。</p>
      <label>角色形体 <select id="head-tilt-source"><option value="current">当前照片的透明候选</option><option value="reference">已审核原猫形体（后身、后爪与尾巴为推断）</option><option value="reference-candidate">待审原猫校准形体（身体推断，未经安装批准）</option></select></label>
      <p>当前透明候选需先完成照片的九点脸部标注及确认。原猫形体仅能用于指定原照，不替换其他猫狗。</p>
      <div class="segmentation-editor-tools">
        <label>幅度 <select id="head-tilt-degrees"><option value="4">轻微 · 4°</option><option value="8" selected>清楚 · 8°</option></select></label>
        <label>方向 <select id="head-tilt-direction"><option value="left">画面左侧</option><option value="right">画面右侧</option></select></label>
        <label>时长 <select id="head-tilt-seconds"><option value="2">2 秒</option><option value="3" selected>3 秒</option><option value="4">4 秒</option></select></label>
      </div>
      <label><input id="head-tilt-confirm" type="checkbox">我已检查形体和脸部位置，理解画外身体或被遮挡部位未经照片证实</label>
      <button id="head-tilt-run" class="secondary-button" type="button">生成歪头待审候选</button>
      <button id="eye-motion-run" class="secondary-button" type="button">生成轻眨眼与局部二维歪头三动作候选</button>
      <button id="model-bundle-run" class="secondary-button" type="button" disabled>生成模型歪头与轻眨眼三动作候选</button>
      <button id="model-head-run" class="secondary-button" type="button" disabled>生成模型好奇歪头候选</button>
      <label>模型歪头幅度 <select id="model-head-intensity"><option value="curious" selected>清楚 · 10°</option><option value="gentle">轻微 · 4°（大幅度失败时可重试）</option></select></label>
      <label><input id="model-head-refinement" type="checkbox" disabled>使用待审透明修整：补实心毛发内部 alpha、修上耳轮廓和孤立碎片；不用于透明饰品，可能损失细毛</label>
      <p id="model-head-status" role="status">模型动作按所选幅度歪头、短暂停留后回正，3 秒；文字仅记录，上方二维动作参数不用于此动作。本地模型仍需配置，结果待审。</p>
      <p>三动作使用固定的本地 AI 轻眨眼模板，歪头使用上方参数。文字不会直接改变眨眼动作；需要另行配置本地动物模型，不发送照片到远程服务。生成结果仍需逐动作审核。</p>
      <details>
        <summary>本地动物动作模型设置</summary>
        <p>选择已准备好的本机动物动画后端目录，包含模型、推理程序和 Python 环境。安装版保存此设置，重启后可继续使用；工坊安装包尚未包含这些模型。仅在生成候选时使用，不影响桌宠离线播放。</p>
        <label>后端目录<input id="animal-backend-root" type="text" autocomplete="off" spellcheck="false" placeholder="例如 E:\\AI-PET"></label>
        <button id="animal-backend-save" class="secondary-button" type="button">检查并保存目录</button>
        <button id="animal-backend-disable" class="secondary-button" type="button">停用动物动作模型</button>
      </details>
      <p id="animal-backend-status" role="status">正在检查本地眨眼模型…</p>
      <button id="head-tilt-history" class="secondary-button" type="button">恢复当前照片的最近候选</button>
      <p id="head-tilt-status" role="status">制作在本机进行，服务不可用时会明确提示；不会自动批准或安装。</p>
      <div id="head-tilt-candidates" aria-label="歪头候选比较"></div>
    </section>`);
  let headTiltAiRecord = null;
  let animalBackendReady = false;
  let modelHeadReady = false;
  let modelBundleReady = false;
  const showAnimalBackend = (state) => {
    animalBackendReady = state.ready === true;
    byId('eye-motion-run').disabled = !animalBackendReady;
    byId('animal-backend-root').value = state.configuration?.root || '';
    byId('animal-backend-status').textContent = animalBackendReady
      ? `本地眨眼模型可用${state.configuration?.source === 'saved' ? '，目录设置已保存' : ''}。生成结果仍需审核。`
      : `眨眼模型未就绪：${state.unavailableReason || '请选择完整的本地后端目录'}。歪头候选仍可单独制作。`;
  };
  byId('eye-motion-run').disabled = true;
  const refreshAnimalBackend = async () => {
    try {
      const response = await fetch('http://127.0.0.1:4180/api/capabilities');
      if (!response.ok) throw new Error('本机制作服务不可用');
      const capability = await response.json();
      showFaceBackend(capability.facePoints);
      showAnimalBackend(capability.eyeMotion);
      modelHeadReady = capability.modelHead?.ready === true;
      modelBundleReady = capability.modelBundle?.ready === true;
      byId('model-bundle-run').disabled = !modelBundleReady;
      byId('model-head-refinement').disabled = !capability.modelHead?.refinementReady;
      byId('model-head-run').disabled = !modelHeadReady;
      byId('model-head-status').textContent = modelHeadReady
        ? '本地模型可用。按所选模型幅度歪头、短停后回正，3 秒。大幅度失败可选择轻微动作重新生成；不会放宽形变检查。文字仅记录，上方二维动作参数不用于此动作。结果待审。'
        : `模型歪头未就绪：${capability.modelHead?.unavailableReason || '本地模型环境缺失'}。`;
    } catch (error) {
      faceBackendReady=false;byId('photo-face-run').disabled=true;
      animalBackendReady = false; byId('eye-motion-run').disabled = true;
      modelHeadReady = false; byId('model-head-run').disabled = true;
      modelBundleReady = false; byId('model-bundle-run').disabled = true;
      byId('animal-backend-status').textContent = `无法检查眨眼模型：${error.message}`;
    }
  };
  const saveAnimalBackend = async (disable) => {
    byId('animal-backend-save').disabled = true; byId('animal-backend-disable').disabled = true;
    try {
      const response = await fetch('http://127.0.0.1:4180/api/animal-backend', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({root:disable ? null : byId('animal-backend-root').value.trim()})
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '配置未保存');
      showAnimalBackend(result);
      await refreshAnimalBackend();
    } catch (error) { byId('animal-backend-status').textContent = `配置未保存：${error.message}。已有目录设置保持。`; }
    finally { byId('animal-backend-save').disabled = false; byId('animal-backend-disable').disabled = false; }
  };
  byId('animal-backend-save').addEventListener('click', () => saveAnimalBackend(false));
  byId('animal-backend-disable').addEventListener('click', () => saveAnimalBackend(true));
  refreshAnimalBackend();
  const tiltReviewReasons = {identity:'身份变化',motion:'动作或时序问题',anatomy:'形体异常',crop:'裁切',edge:'残边或透明问题'};
  const renderTiltCandidate = (result, plan, usesAi) => {
    const modelBundle = result.motionKind === 'model-bundle';
    const bundle = result.motionKind === 'eye-bundle' || modelBundle;
    const modelHead = result.motionKind === 'model-head';
    const multi = bundle || modelHead;
    const modelTemplates = ['curious-head-tilt','curious-head-tilt-refined','gentle-head-tilt','gentle-head-tilt-refined'];
    const modelDegrees = plan.template?.startsWith('gentle-') ? 4 : 10;
    if (modelBundle && (plan.action !== 'model-head-template' || !modelTemplates.includes(plan.template) || usesAi || result.frameCount !== 240 || result.actions?.map(a=>`${a.slot}:${a.fps}:${a.frameCount}`).join(',') !== 'idle:20:120,hover:20:60,click:20:60')) throw new Error('模型三动作记录不匹配');
    if (modelHead && (plan.action !== 'model-head-template' || !modelTemplates.includes(plan.template) || usesAi)) throw new Error('模型模板记录不匹配');
    if (modelHead && (!Array.isArray(result.actions) || result.actions.map(a=>a.slot).join(',') !== 'idle,hover' || result.actions.some(a=>a.fps !== 20 || a.frameCount !== (a.slot === 'idle' ? 2 : 60)) || result.frameCount !== 62)) throw new Error('模型动作记录不匹配');
    if (!/^[a-f0-9]{32}$/.test(result.candidateId) || !/^[a-f0-9]{64}$/.test(result.packageSha256) || result.approved !== false || result.installable !== false || !Number.isInteger(result.frameCount) || result.frameCount < 30 || result.frameCount > ((bundle || modelBundle) ? 280 : 100) || (result.reviewIssue && !Object.hasOwn(tiltReviewReasons,result.reviewIssue))) throw new Error('候选审核记录无效');
    if (bundle && (!Array.isArray(result.actions) || result.actions.length !== 3 || result.actions.map(a=>a.slot).join(',') !== 'idle,hover,click' || result.actions.some(a=>a.fps !== 20 || !Number.isInteger(a.frameCount) || a.frameCount < 2 || a.frameCount > 120) || result.actions.reduce((n,a)=>n+a.frameCount,0) !== result.frameCount)) throw new Error('多动作记录不匹配');
    const prefix = `http://127.0.0.1:4180/candidate/${result.candidateId}/`;
    for (const file of ['hover-190px.mp4','report.json','candidate.lotheme',...(multi ? ['idle-190px.mp4'] : []),...(bundle ? ['click-190px.mp4'] : [])]) if (result.assets?.[file] !== prefix+file) throw new Error('候选链接不匹配');
    const previousCard = byId('head-tilt-candidates').querySelector(`[data-candidate-id="${result.candidateId}"]`);
    previousCard?._releaseFrame?.(); previousCard?.remove();
    const card = document.createElement('article'); card.className = 'segmentation-editor'; card.dataset.candidateId = result.candidateId;
    const title = document.createElement('h4');
    const video = document.createElement('video'); video.src = result.assets['hover-190px.mp4']; video.controls = true; video.loop = true; video.muted = true; video.style.maxWidth = '100%';
    const initialCount = multi ? result.actions.find(a=>a.slot === 'hover').frameCount : result.frameCount;
    const viewLabel = document.createElement('label'); viewLabel.textContent = '显示方式';
    const viewSelect = document.createElement('select'); viewSelect.setAttribute('aria-label','显示方式');
    for (const [value,text] of [['playback','正常速度原始动作'],['frames','原始透明帧'],['video','压缩视频对照']]) {
      const option = document.createElement('option'); option.value=value; option.textContent=text; viewSelect.append(option);
    }
    viewLabel.append(viewSelect);
    const rawView = document.createElement('div'); rawView.className='tilt-raw-review'; rawView.hidden=true;
    const frameStatus = document.createElement('p'); frameStatus.setAttribute('role','status'); frameStatus.dataset.rawFrameStatus='true';
    const fullFrame = document.createElement('a'); fullFrame.textContent='放大当前原始透明帧'; fullFrame.target='_blank'; fullFrame.rel='noopener'; fullFrame.hidden=true;
    const player=new ThemeFramePlayer(prefix,result.packageSha256,index=>{
      if(viewSelect.value==='playback') {scrub.value=String(index);frameNote.textContent=`第 ${index+1} 帧`;}
    }); card._framePlayer=player;
    let selectedSlot='hover', rawRevision=0, rawController, rawUrl;
    const releaseFrame = () => { rawRevision++; rawController?.abort(); if (rawUrl) URL.revokeObjectURL(rawUrl); rawUrl=undefined; };
    card._releaseFrame=()=>{releaseFrame();player.dispose();};
    const showVideo = () => {
      releaseFrame();player.reset();player.element.hidden=true;rawView.replaceChildren(); rawView.hidden=true; fullFrame.hidden=true; video.hidden=false;
      frameStatus.textContent='压缩视频仅用于对照；正常速度原始动作使用主题包的透明帧。';
    };
    const showPlayback=()=>{
      releaseFrame();video.pause();video.hidden=true;rawView.hidden=true;fullFrame.hidden=true;
      player.element.hidden=false;frameStatus.textContent='请完整播放并检查动作起势、停留和回正；尚未批准。';
      player.prepare(selectedSlot,true);
    };
    const showRawFrame = async () => {
      releaseFrame(); const revision=rawRevision; const slot=selectedSlot; const index=Number(scrub.value);
      player.reset();player.element.hidden=true;video.pause(); video.hidden=true; rawView.hidden=true; fullFrame.hidden=true;
      frameStatus.textContent='正在读取原始透明帧…';
      rawController=new AbortController();
      const uri=`${prefix}frame/${slot}/${index}.png?sha256=${result.packageSha256}`;
      let pendingUrl;
      try {
        const response=await fetch(uri,{signal:rawController.signal});
        if (!response.ok) throw new Error('原始帧无法核验或读取，请重新打开制作记录。');
        const blob=await response.blob(); const digest=response.headers.get('X-Frame-Sha256');
        if (blob.type!=='image/png' || !/^[a-f0-9]{64}$/.test(digest || '') || await localSha256(blob)!==digest) throw new Error('原始帧指纹不匹配。');
        pendingUrl=URL.createObjectURL(blob);
        const panels=await Promise.all(['暖色','蓝色','深色'].map(async (color,col) => {
          const panel=document.createElement('div'); panel.className=`tilt-raw-panel tilt-raw-panel-${col}`;
          const image=new Image(); image.alt=`待审${color}背景，${slot}第${index+1}帧`; image.src=pendingUrl;
          await image.decode(); panel.append(image); return panel;
        }));
        if (revision!==rawRevision || viewSelect.value!=='frames') {URL.revokeObjectURL(pendingUrl);return;}
        rawUrl=pendingUrl; rawView.replaceChildren(...panels); rawView.hidden=false;
        rawView.dataset.slot=slot; rawView.dataset.frame=String(index); rawView.dataset.sha256=digest;
        fullFrame.href=uri; fullFrame.hidden=false;
        frameStatus.textContent=`原始透明帧，第${index+1}帧；请比较三背景边缘，也可放大检查。尚未批准。`;
      } catch (error) {
        if (pendingUrl) URL.revokeObjectURL(pendingUrl);
        if (revision===rawRevision && error.name!=='AbortError') frameStatus.textContent=error.message;
      }
    };
    viewSelect.addEventListener('change',()=>{if(viewSelect.value==='frames')showRawFrame();else if(viewSelect.value==='playback')showPlayback();else showVideo();});
    const scrubLabel = document.createElement('label'); scrubLabel.textContent = '逐帧检查';
    const scrub = document.createElement('input'); scrub.type = 'range'; scrub.min = '0'; scrub.max = String(initialCount-1); scrub.step = '1'; scrub.value = '0'; scrub.setAttribute('aria-label', modelHead ? '模型好奇歪头候选逐帧检查' : `${plan.degrees}度候选逐帧检查`);
    const frameNote = document.createElement('output'); frameNote.textContent = '第 1 帧';
    scrub.addEventListener('input', () => { video.pause(); video.currentTime = Number(scrub.value)/20; frameNote.textContent = `第 ${Number(scrub.value)+1} 帧`; viewSelect.value='frames'; showRawFrame(); });
    scrubLabel.append(scrub,frameNote);
    if (multi) {
      const actionLabel = document.createElement('label'); actionLabel.textContent = '检查动作';
      const actionSelect = document.createElement('select'); actionSelect.dataset.eyeMotionSlot = 'true';
      for (const [slot,label] of (modelHead ? [['idle','原形体静态待机'],['hover','模型好奇歪头']] : [['idle','安静待机，偶尔轻眨眼'],['hover','歪头看看'],['click','轻眨眼回应']])) {
        const option = document.createElement('option'); option.value = slot; option.textContent = label; actionSelect.append(option);
      }
      actionSelect.value = 'hover';
      actionSelect.addEventListener('change', () => {
        selectedSlot=actionSelect.value;
        video.pause(); video.src = result.assets[`${actionSelect.value}-190px.mp4`]; video.load();
        scrub.max = String(result.actions.find(a=>a.slot === actionSelect.value).frameCount-1); scrub.value = '0'; frameNote.textContent = '第 1 帧';
          if(viewSelect.value==='frames')showRawFrame();else if(viewSelect.value==='playback')showPlayback();
      });
      actionLabel.append(actionSelect); card.append(actionLabel);
    }
    const note = document.createElement('p'); note.textContent = `Prompt：${plan.prompt}。${plan.inferredParts} ${usesAi ? 'AI 将文字解释为受限参数，服务已核对保存的计划与实际动作参数。' : '动作由手动所选参数生成，文字仅记录。'}请检查三背景完整播放、身份、颈部形变和边缘；待审主题还需桌面逐动作审核。`;
    if (modelHead) note.textContent = `Prompt：${plan.prompt}。${plan.inferredParts} 固定本地模型动作：${modelDegrees}°歪头、短暂停留后回正，3 秒。文字仅记录，未解释为动作。请检查三背景完整播放、身份、颈部形变和边缘；还需实际桌面审核。`;
    if (bundle) note.textContent += ' 轻眨眼来自固定本地 AI 模板，不代表文字中的任意动作已执行。';
    if (modelBundle) note.textContent = `Prompt：${plan.prompt}。${plan.inferredParts} 固定本地模型三动作：模型歪头${modelDegrees}°、短停后回正，轻眨眼用于待机及点击。三个动作共用同一回正形体，文字仅记录；请完整检查身份、动作衔接和透明边缘。尚未批准或安装。`;
    if ((modelHead || modelBundle) && plan.template.endsWith('-refined')) note.textContent += ' 已选择待审透明修整：内部高 alpha 补实心、上耳使用真实模型轮廓，仅清理模型不支持的微小孤立碎片。可能损失细毛；源和动作均未经批准，修整前后指纹在制作记录中。';
    if (result.singleActionRedo) {
      const redo=result.singleActionRedo;
      if (!modelBundle || redo.slot!=='hover' || !/^[a-f0-9]{32}$/.test(redo.parentCandidateId) || !/^[a-f0-9]{64}$/.test(redo.parentPackageSha256) || redo.retainedActions?.join(',')!=='idle,click') throw new Error('单动作重做来源不匹配');
      note.textContent += ` 仅重做歪头；待机和点击保留原始眨眼帧。上一个候选 ${redo.parentCandidateId.slice(0,8)} 保留，可在下方比较或重新打开。原审核决定仍有效，新候选仍待审。`;
      card.dataset.redoParent=redo.parentCandidateId;
    }
    const link = document.createElement('a'); link.href = result.assets['candidate.lotheme']; link.download = 'head-tilt-candidate.lotheme'; link.textContent = '下载待审主题'; link.className = 'segmentation-download';
    const trace = document.createElement('a'); trace.href = result.assets['report.json']; trace.target = '_blank'; trace.rel = 'noopener'; trace.textContent = '查看制作记录'; trace.className = 'segmentation-download';
    const reasonLabel = document.createElement('label'); reasonLabel.textContent = '需修改原因';
    const reason = document.createElement('select'); reason.setAttribute('aria-label','需修改原因');
    for (const [value,text] of Object.entries(tiltReviewReasons)) { const option = document.createElement('option'); option.value = value; option.textContent = text; reason.append(option); }
    reasonLabel.append(reason);
    const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'secondary-button'; reject.textContent = '记录需修改并阻止安装';
    const reviewStatus = document.createElement('p'); reviewStatus.setAttribute('role','status');
    const redoButton=document.createElement('button');redoButton.type='button';redoButton.className='secondary-button';redoButton.dataset.redoHead='true';
    redoButton.textContent=`只重做歪头为 ${modelDegrees===10 ? 4 : 10}°，保留轻眨眼`;
    const redoStatus=document.createElement('p');redoStatus.setAttribute('role','status');redoStatus.dataset.redoStatus='true';
    let reviewIssue=result.reviewIssue;
    const showDecision = issue => {
      reviewIssue=issue;
      redoButton.disabled=Boolean(issue && issue!=='motion');
      title.textContent = modelBundle ? `模型三动作 · ${modelDegrees}°歪头与轻眨眼 · ${issue ? '需修改' : '待审'}` : modelHead ? `模型好奇歪头 · ${modelDegrees}° · 3 秒 · ${issue ? '需修改' : '待审'}` : `${bundle ? '三动作 · ' : ''}${plan.degrees}° · ${plan.durationSeconds} 秒 · ${plan.direction === 'left' ? '左' : '右'}倾 · ${issue ? '需修改' : '待审'}`;
      reject.disabled = Boolean(issue); reason.disabled = Boolean(issue); link.hidden = Boolean(issue);
      if (issue) { reason.value = issue; reviewStatus.textContent = `已记录：${tiltReviewReasons[issue]}。此包及其改名副本均被本机桌宠阻止安装；请修改后生成新候选。`; }
      else reviewStatus.textContent = '尚未获视觉批准。发现问题后可记录原因，已有下载也会被本机安装审核拦截。';
    };
    showDecision(result.reviewIssue);
    if (modelBundle) {
      redoButton.addEventListener('click',async()=>{
        const selectedPhoto=photoSource;redoButton.disabled=true;
        const nextPlan={...plan,template:`${modelDegrees===10 ? 'gentle' : 'curious'}-head-tilt${plan.template.endsWith('-refined') ? '-refined' : ''}`};
        try {
          const photoHash=await localSha256(await portraitPhotoSourceBlob(selectedPhoto));
          if (photoHash!==result.photoSha256) throw new Error('请重新打开此候选对应的照片');
          redoStatus.textContent='正在单独重新生成模型歪头；原眨眼帧及旧候选保留…';
          const response=await fetch('http://127.0.0.1:4180/api/model-bundle/redo-head',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parentCandidateId:result.candidateId,parentPackageSha256:result.packageSha256,photoSha256:result.photoSha256,plan:nextPlan}),signal:AbortSignal.timeout(900000)});
          const next=await response.json();
          if (!response.ok) throw new Error(next.error || '单动作重做未完成');
          if (selectedPhoto!==photoSource) throw new Error('照片已更换；结果已保留，请打开原照片的制作记录');
          if (next.photoSha256!==result.photoSha256 || next.sourceSha256!==result.sourceSha256 || next.singleActionRedo?.parentCandidateId!==result.candidateId || next.singleActionRedo?.parentPackageSha256!==result.packageSha256) throw new Error('重做结果与原候选来源不匹配');
          renderTiltCandidate(next,nextPlan,false);redoStatus.textContent='歪头单独重做完成，新旧候选均保留。请比较起势、停留和回正；尚未批准。';
        } catch (error) {redoStatus.textContent=`单动作重做未完成：${error.message}。旧候选及审核记录保留。`;}
        finally {redoButton.disabled=Boolean(reviewIssue && reviewIssue!=='motion');}
      });
    }
    reject.addEventListener('click', async () => {
      reject.disabled = true;
      try {
        const response = await fetch('http://127.0.0.1:4180/api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({candidateId:result.candidateId,packageSha256:result.packageSha256,reason:reason.value}),signal:AbortSignal.timeout(10000)});
        const decision = await response.json();
        if (!response.ok || decision.candidateId !== result.candidateId || decision.packageSha256 !== result.packageSha256 || !Object.hasOwn(tiltReviewReasons,decision.reviewIssue)) throw new Error(decision.error || '记录不匹配');
        showDecision(decision.reviewIssue);
      } catch (error) { reviewStatus.textContent = `未保存审核决定：${error.message}。请重试。`; reject.disabled = false; }
    });
      card.append(title,viewLabel,player.element,video,rawView,scrubLabel,frameStatus,fullFrame,note,reasonLabel,reject,reviewStatus,link,trace); byId('head-tilt-candidates').prepend(card);
      if(modelBundle)card.append(redoButton,redoStatus);
      showPlayback();
  };
  byId('head-tilt-history').addEventListener('click',async event => {
    const button = event.currentTarget; const source = photoSource; button.disabled = true;
    try {
      const photoHash = await localSha256(await portraitPhotoSourceBlob(source));
      const response = await fetch(`http://127.0.0.1:4180/api/candidates/${photoHash}`,{signal:AbortSignal.timeout(15000)});
      const history = await response.json();
      if (!response.ok || !Array.isArray(history.candidates) || history.candidates.length > 24) throw new Error('无法恢复制作记录');
      if (source !== photoSource) throw new Error('照片已更换，未关联旧记录');
      for (const result of [...history.candidates].reverse()) {
        if (result.photoSha256 !== photoHash) throw new Error('候选与当前照片不匹配');
        renderTiltCandidate(result,result.plan,Boolean(result.aiPlan));
      }
      headTiltPhotoSource = source;
      byId('head-tilt-status').textContent = `已恢复最近 ${history.candidates.length} 个候选及审核决定；${history.unavailable} 个不完整或无法核验的记录未载入。未批准或安装。`;
    } catch (error) { byId('head-tilt-status').textContent = `恢复失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  let headTiltAiBusy = false;
  let headTiltAiRevision = 0;
  const tiltAiContext = () => JSON.stringify([photoSource, byId('head-tilt-prompt').value.trim(), byId('head-tilt-source').value]);
  const tiltParameters = () => ({degrees:Number(byId('head-tilt-degrees').value),durationSeconds:Number(byId('head-tilt-seconds').value),direction:byId('head-tilt-direction').value});
  const updateTiltAiButton = () => { byId('head-tilt-ai-run').disabled = headTiltAiBusy || byId('head-tilt-planning').value !== 'ai' || !byId('head-tilt-ai-consent').checked; };
  for (const id of ['photo-input','head-tilt-planning','head-tilt-ai-consent','head-tilt-prompt','head-tilt-source','head-tilt-degrees','head-tilt-direction','head-tilt-seconds']) {
    byId(id).addEventListener('input', () => { headTiltAiRevision += 1; headTiltAiRecord = null; updateTiltAiButton(); byId('head-tilt-ai-status').textContent = byId('head-tilt-planning').value === 'ai' ? '当前描述或设置已变更，请重新解释 Prompt。' : '手动模式：只执行所选参数，文字保存在制作记录中。'; });
  }
  byId('head-tilt-ai-run').addEventListener('click', async () => {
    if (headTiltAiBusy || !byId('head-tilt-ai-consent').checked || byId('head-tilt-planning').value !== 'ai') return;
    const context = tiltAiContext(); const prompt = byId('head-tilt-prompt').value.trim();
    const revision = headTiltAiRevision;
    const status = byId('head-tilt-ai-status');
    if (!prompt) { status.textContent = '请先填写动作描述。'; return; }
    headTiltAiRecord = null; headTiltAiBusy = true; updateTiltAiButton();
    const requestId = crypto.randomUUID().replaceAll('-', '');
    status.textContent = '正在解释文字；照片没有发送。';
    try {
      const response = await fetch('http://127.0.0.1:4178/api/plan', {method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(115000),
        body:JSON.stringify({requestId,action:'歪头看看',mode:'real',prompt,traits:[],evidence:['face'],consent:{accepted:true,provider:'OpenAI Codex CLI',photoSent:false}})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '文字解释失败');
      if (context !== tiltAiContext() || !byId('head-tilt-ai-consent').checked || byId('head-tilt-planning').value !== 'ai') throw new Error('生成期间设置已变化，旧解释未应用');
      const execution = result.plan?.headTiltExecution;
      const promptHash = await localSha256(new Blob([prompt], {type:'text/plain'}));
      if (revision !== headTiltAiRevision || context !== tiltAiContext()) throw new Error('生成期间设置已变化，旧解释未应用');
      if (!/^[a-f0-9]{32}$/.test(result.id) || result.promptSha256 !== promptHash || result.model !== 'gpt-6-luna' || result.adapter !== 'Codex CLI' || result.status !== 'plan-requires-human-review' || result.photoSent !== false || result.installable !== false || result.plan?.action !== 'head-tilt' || typeof execution?.supported !== 'boolean' || typeof execution.reason !== 'string' || execution.reason.length > 240) throw new Error('解释来源不匹配');
      if (execution.supported === false && result.route === 'unsupported-head-tilt-request') { status.textContent = `未支持：${execution.reason} 请修改描述，或明确切换手动参数模式。`; return; }
      if (result.route !== 'local-head-tilt-review' || !execution.supported || ![4,8].includes(execution.degrees) || ![2,3,4].includes(execution.durationSeconds) || !['left','right'].includes(execution.direction)) throw new Error('解释超出动作模板参数范围');
      byId('head-tilt-degrees').value = String(execution.degrees); byId('head-tilt-seconds').value = String(execution.durationSeconds); byId('head-tilt-direction').value = execution.direction;
      headTiltAiRecord = {id:result.id,promptSha256:result.promptSha256,context,parameters:JSON.stringify(tiltParameters())};
      status.textContent = `已应用：向画面${execution.direction === 'left' ? '左' : '右'}侧 ${execution.degrees}°，${execution.durationSeconds} 秒并回正。${execution.reason} 尚未生成或批准素材。`;
    } catch (error) { status.textContent = `未应用文字解释：${error.message}`; }
    finally { headTiltAiBusy = false; updateTiltAiButton(); }
  });
  const runTiltCandidate = async (event) => {
    const button = event.currentTarget;
    const bundle = button.id === 'eye-motion-run';
    const modelBundle = button.id === 'model-bundle-run';
    const modelHead = button.id === 'model-head-run' || modelBundle;
    const refinement = modelHead && byId('model-head-refinement').checked;
    const modelIntensity = byId('model-head-intensity').value;
    const sourcePhoto = photoSource;
    const revision = segmentationCandidateRevision;
    const sourceMode = byId('head-tilt-source').value;
    const prompt = byId('head-tilt-prompt').value.trim();
    const status = byId('head-tilt-status');
    const usesAi = !modelHead && byId('head-tilt-planning').value === 'ai';
    if (modelHead && byId('head-tilt-planning').value === 'ai') { status.textContent = '模型好奇歪头是固定模板，文字仅记录。请切换手动参数模式后生成。'; return; }
    const appliedAi = headTiltAiRecord;
    if (usesAi && (!appliedAi || appliedAi.context !== tiltAiContext() || appliedAi.parameters !== JSON.stringify(tiltParameters()) || !byId('head-tilt-ai-consent').checked)) { status.textContent = '请先解释并应用当前 Prompt；不支持或已过期的解释不能生成。'; return; }
    if (!byId('head-tilt-confirm').checked) { status.textContent = '请先核对形体、脸部位置和推断范围。'; return; }
    if (!prompt) { status.textContent = '请填写本次动作 Prompt，作为候选的制作记录。'; return; }
    byId('head-tilt-run').disabled = true; byId('eye-motion-run').disabled = true; byId('model-head-run').disabled = true; byId('model-bundle-run').disabled = true;
    const controlsKey = JSON.stringify([tiltParameters(),byId('head-tilt-source').value]);
    try {
      const photoBlob = await portraitPhotoSourceBlob(sourcePhoto);
      const photoHash = await localSha256(photoBlob);
      let sourceCanvas, sourceAsset, points, inferred;
      if (sourceMode === 'reference' || sourceMode === 'reference-candidate') {
        if (photoHash !== '112378a4bc93c8ae87aa71932f2309ddc41b6f3e3906c1e1e43701803409d209') throw new Error('当前照片不是指定原猫原照，不能借用这个角色形体。');
        const pending = sourceMode === 'reference-candidate';
        const asset = await (await fetch(pending ? './assets/pending-model-reference-cat.png' : './assets/reviewed-reference-cat.png')).blob();
        if (await localSha256(asset) !== (pending ? '86800161b67b3d875f0739361f4f807d862d4b0337f6ed84517ad62669df08d7' : '18211bc484a19516a176c54402145300ef32f8613bcbc971377f48b1669e5cf8')) throw new Error('原猫形体指纹不匹配。');
        sourceAsset = asset;
        const bitmap = await createImageBitmap(asset);
        sourceCanvas = document.createElement('canvas'); sourceCanvas.width = bitmap.width; sourceCanvas.height = bitmap.height;
        sourceCanvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
        points = [[160,111],[179,111],[212,112],[228,113],[195,136],[177,150],[209,151],[195,147],[195,157]].map(([x,y]) => [x/640,y/384]);
        inferred = '后身、后爪及尾巴外形和花纹为推断；脸部点位来自该形体的人工标注。';
        if (pending) inferred += ' 此形体经过透明轮廓校准，仍待身份、细毛和正常速度审核，未获安装批准。';
      } else {
        if (segmentationPreviewPhoto !== sourcePhoto || !segmentationEditor.canvas || !manualFaceReady()) throw new Error('请为当前照片生成透明候选，并完成上方九点脸部标注及确认。');
        if (!fullBodyPhotoEligible()) throw new Error('当前照片的完整轮廓尚未确认；先补充完整照片或使用明确标注的原猫推断形体。');
        const original = segmentationEditor.canvas;
        const scale = Math.min(1, 768/Math.max(original.width, original.height));
        sourceCanvas = document.createElement('canvas'); sourceCanvas.width = Math.round(original.width*scale); sourceCanvas.height = Math.round(original.height*scale);
        sourceCanvas.getContext('2d').drawImage(original, 0, 0, sourceCanvas.width, sourceCanvas.height);
        points = manualFace.points.map(point => [...point]);
        inferred = '仅保留当前透明素材；遮挡部位未经验证，不在本次生成中补画。';
        if (segmentationEditor.matteReport) inferred += `毛边透明度及颜色经过本机细化，候选 ${segmentationEditor.matteReport.candidateId}，输出 SHA256 ${segmentationEditor.matteReport.outputSha256}；当前修整及缩放后的素材另以 sourceSha256 记录。`;
      }
      const capability = await (await fetch('http://127.0.0.1:4180/api/capabilities', {signal:AbortSignal.timeout(5000)})).json();
      if (capability.ready !== true || capability.route !== 'transparent-head-tilt-v1' || capability.remoteNetworkUsed !== false || capability.requiresHumanReview !== true || capability.promptProseExecuted !== false) throw new Error('本机动作服务未就绪或缺少视频编码器。');
      if (bundle && (capability.eyeMotion?.ready !== true || capability.eyeMotion?.route !== 'transparent-eye-bundle-v1' || capability.eyeMotion?.remoteNetworkUsed !== false || capability.eyeMotion?.requiresHumanReview !== true || capability.eyeMotion?.promptProseExecuted !== false)) throw new Error('本地动物模型或编码器不可用；未生成模拟候选。歪头单动作仍可单独制作。');
      if (modelHead && (capability.modelHead?.ready !== true || capability.modelHead?.route !== 'model-head-template-v1' || capability.modelHead?.template !== 'curious-head-tilt')) throw new Error('本地模型歪头环境未就绪，未生成候选。');
      if (modelBundle && (capability.modelBundle?.ready !== true || capability.modelBundle?.route !== 'model-motion-bundle-v1')) throw new Error('真实模型三动作环境未就绪，未生成候选。');
      if (refinement && capability.modelHead?.refinementReady !== true) throw new Error('待审透明修整环境未就绪，未转为普通候选。');
      // Preserve the checked reference PNG bytes; Canvas rounds translucent RGB.
      const encodedSource = sourceAsset ? `data:image/png;base64,${await blobToBase64(sourceAsset)}` : sourceCanvas.toDataURL('image/png');
      const blob = new Blob([Uint8Array.from(atob(encodedSource.split(',')[1]), char => char.charCodeAt(0))], {type:'image/png'});
      const sourceHash = await localSha256(blob);
      if (modelHead && !['curious','gentle'].includes(modelIntensity)) throw new Error('请选择有效的模型动作幅度。');
      const modelTemplate = `${modelIntensity === 'gentle' ? 'gentle' : 'curious'}-head-tilt${refinement ? '-refined' : ''}`;
      const plan = {version:1,...(modelHead ? {action:'model-head-template',template:modelTemplate} : {action:'head-tilt',degrees:Number(byId('head-tilt-degrees').value),durationSeconds:Number(byId('head-tilt-seconds').value),direction:byId('head-tilt-direction').value}),prompt,
        facePointsNormalized:points,facePointsConfirmed:true,sourceSha256:sourceHash,inferredParts:inferred};
      status.textContent = modelBundle ? '正在本机依次生成真实模型歪头和轻眨眼，再组合三动作；文字仅记录，结果待审。' : modelHead ? '正在本机生成固定模型好奇歪头；需运行模型和透明处理，结果仍待审核。' : bundle ? '正在本机生成三动作；保留原照、形体及模型记录，尚未批准或安装。' : '正在本机生成歪头动作；保留照片、形体与参数指纹，生成后仍需审核。';
      const response = await fetch(`http://127.0.0.1:4180/api/${modelBundle ? 'model-bundle' : modelHead ? 'model-head' : bundle ? 'eye-motion' : 'head-tilt'}`, {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({imageBase64:encodedSource.split(',')[1],photoSha256:photoHash,plan,...(bundle ? {eyeMotion:{version:1,template:'wink-and-head-tilt',multiplier:1.5}} : {}),...(usesAi ? {aiPlan:{id:appliedAi.id,promptSha256:appliedAi.promptSha256}} : {})}),signal:AbortSignal.timeout(modelBundle ? 900000 : (bundle || modelHead) ? 600000 : 90000)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '生成失败');
      if (modelHead && byId('model-head-refinement').checked !== refinement) throw new Error('生成期间透明修整选择已变化，旧候选未关联当前角色。');
      if (modelHead && byId('model-head-intensity').value !== modelIntensity) throw new Error('生成期间模型幅度已变化，旧候选未关联当前角色。');
      if (usesAi && (headTiltAiRecord !== appliedAi || appliedAi.context !== tiltAiContext() || appliedAi.parameters !== JSON.stringify(tiltParameters()))) throw new Error('生成期间 AI 参数已变化，旧候选未关联当前角色');
      if (controlsKey !== JSON.stringify([tiltParameters(),byId('head-tilt-source').value]) || photoSource !== sourcePhoto || (sourceMode === 'current' && (revision !== segmentationCandidateRevision || !manualFaceReady() || JSON.stringify(manualFace.points) !== JSON.stringify(points))) || byId('head-tilt-prompt').value.trim() !== prompt || !byId('head-tilt-confirm').checked) throw new Error('生成期间照片、透明形体、脸部标注或 Prompt 已变化；旧结果保存在本机，未关联当前角色。');
      if (!/^[a-f0-9]{32}$/.test(result.candidateId) || result.approved !== false || result.installable !== false || !Number.isInteger(result.frameCount) || result.frameCount < 30 || result.frameCount > ((bundle || modelBundle) ? 280 : 100) || result.photoSha256 !== photoHash || result.sourceSha256 !== sourceHash || (bundle && result.motionKind !== 'eye-bundle') || (modelHead && result.motionKind !== (modelBundle ? 'model-bundle' : 'model-head'))) throw new Error('候选来源或审核状态不匹配。');
      const prefix = `http://127.0.0.1:4180/candidate/${result.candidateId}/`;
      for (const file of ['hover-190px.mp4','report.json','candidate.lotheme']) if (result.assets?.[file] !== prefix+file) throw new Error('候选链接不匹配。');
      renderTiltCandidate(result,plan,usesAi); headTiltPhotoSource = sourcePhoto;
      status.textContent = modelBundle ? '真实模型三动作候选已生成，请完整检查三个动作、身份和透明边缘；尚未批准或安装。' : modelHead ? '固定模型候选已生成，请完整检查动作和透明边缘；没有批准或安装。' : '候选已生成，可再改幅度生成另一版比较；没有批准或安装。';
    } catch (error) { status.textContent = `未能关联新候选：${error.message}`; }
    finally { byId('head-tilt-run').disabled = false; byId('eye-motion-run').disabled = !animalBackendReady; byId('model-head-run').disabled = !modelHeadReady; byId('model-bundle-run').disabled = !modelBundleReady; }
  };
  byId('head-tilt-run').addEventListener('click', runTiltCandidate);
  byId('eye-motion-run').addEventListener('click', runTiltCandidate);
  byId('model-head-run').addEventListener('click', runTiltCandidate);
  byId('model-bundle-run').addEventListener('click', runTiltCandidate);
  byId('package-static-theme').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const canvas = segmentationEditor.canvas;
    if (!canvas || !segmentationPreviewPhoto || !segmentationEditor.originalPixels) {
      byId('segmentation-status').textContent = '请先生成透明主体候选，再打包静态主题。';
      return;
    }
    const requestRevision = segmentationCandidateRevision;
    clearSegmentationPackageLink();
    button.disabled = true;
    byId('segmentation-status').textContent = '正在本机打包单帧静态主题候选；不会安装，也不会上传远程服务。';
    try {
      const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!imageBlob) throw new Error('无法读取当前透明候选。');
      const response = await fetch('http://127.0.0.1:4174/api/package-still?adapter=birefnet-local', {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: imageBlob, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error === 'multiple-large-foreground-regions'
          ? '透明图仍有多个分离的大面积前景，可能混入人物或物件；请先修整再打包。'
          : payload.error === 'strong-canvas-edge-contact'
            ? '主体在画框边缘被明显截断；请换无遮挡完整照片或重新制作透明候选，再打包。'
            : payload.error || '本机主题打包服务未就绪。');
      }
      if (!response.headers.get('content-type')?.includes('application/zip')) throw new Error('本机服务返回的不是主题包。');
      const packageBlob = await response.blob();
      const signature = new Uint8Array(await packageBlob.slice(0, 4).arrayBuffer());
      if (signature[0] !== 0x50 || signature[1] !== 0x4b || requestRevision !== segmentationCandidateRevision) {
        throw new Error(requestRevision !== segmentationCandidateRevision ? '打包期间当前候选已变化，旧主题包已丢弃。' : '主题包 ZIP 格式无效。');
      }
      segmentationPackageUrl = URL.createObjectURL(packageBlob);
      const link = byId('download-static-theme');
      link.href = segmentationPackageUrl;
      link.hidden = false;
      byId('segmentation-status').textContent = '单帧静态待审主题已在本机生成；下载后可从桌宠系统托盘导入审核，只有你逐项确认后才会安装。';
      byId('static-package-instructions').hidden = false;
    } catch (error) {
      byId('segmentation-status').textContent = error.name === 'TimeoutError'
        ? '本机主题打包请求超时，未生成下载包。'
        : `未能打包静态主题：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  byId('run-segmentation').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const requestSource = selectedSegmentationSource();
    const requestPhoto = requestSource.photo;
    const selectedAdapter = byId('segmentation-backend').value;
    const requestPrompts = { foreground: [...sam2PromptState.foreground], background: [...sam2PromptState.background] };
    const requestPromptKey = JSON.stringify(requestPrompts);
    const status = byId('segmentation-status');
    const result = byId('segmentation-result');
    const capabilitiesView = byId('segmentation-capabilities');
    button.disabled = true;
    result.hidden = true;
    segmentationCandidateRevision += 1;
    clearPortraitFraming();
    renderActionSuitability();
    clearSegmentationPackageLink();
    status.textContent = '正在本机分析照片……';
    try {
      const capabilityResponse = await fetch(`http://127.0.0.1:4174/api/capabilities?adapter=${selectedAdapter}`, { signal: AbortSignal.timeout(180000) });
      const adapter = await capabilityResponse.json();
      if (!capabilityResponse.ok || adapter.ready !== true || typeof adapter.adapter !== 'string' || !adapter.adapter) throw new Error(adapter.error || '本机模型能力信息无效。');
      if (adapter.adapter !== selectedAdapter) throw new Error('本机分割模型与所选方式不匹配，请重新选择模型后重试。');
      if (adapter.task !== 'single-image-foreground-segmentation' || !adapter.capabilities?.input?.includes('image/png') || !adapter.capabilities?.output?.includes('image/png; RGBA') || !adapter.capabilities?.requiresHumanReview || adapter.capabilities.animationGeneration !== false || adapter.capabilities.identityAnalysis !== false || adapter.privacy?.remoteNetworkUsed !== false || adapter.privacy?.inputPersisted !== false) throw new Error('本机服务的能力、审核或隐私声明不符合预期，已停止发送照片。');
      if (selectedAdapter === 'sam2-local' && (!adapter.capabilities?.promptTypes?.includes('foreground-point') || !adapter.capabilities?.promptTypes?.includes('background-point') || !requestPrompts.foreground.length)) throw new Error('SAM 2 至少需要一个前景点；先在所选照片上点击宠物，再按需要点背景。');
      const requestIsCurrent = () => selectedSegmentationSource().key === requestSource.key && selectedSegmentationSource().photo === requestPhoto && byId('segmentation-backend').value === selectedAdapter && (selectedAdapter !== 'sam2-local' || JSON.stringify({ foreground: sam2PromptState.foreground, background: sam2PromptState.background }) === requestPromptKey);
      capabilitiesView.textContent = `${adapter.model} · ${adapter.modelRevision.slice(0, 12)} · ${adapter.runtime.device} · PyTorch ${adapter.runtime.torch} · ${adapter.runtime.inferenceSize} · 模型卡许可元数据：${adapter.licenseMetadata}（分发前仍需核对代码与权重条款）。${adapter.privacy.temporaryOutputDeletedAfterResponse ? '临时输出在响应后删除。' : ''}`;
      capabilitiesView.hidden = false;
      const requestImage = await imageFromSource(requestPhoto);
      if (!requestIsCurrent()) throw new Error('分割方式、照片或点选已更改，请重新运行透明主体预览。');
      const canvas = document.createElement('canvas');
      canvas.width = requestImage.naturalWidth;
      canvas.height = requestImage.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) throw new Error('当前照片还没有载入完成。');
      context.drawImage(requestImage, 0, 0);
      const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!imageBlob) throw new Error('无法在本机准备照片。');
      const headers = { 'Content-Type': 'image/png' };
      if (selectedAdapter === 'sam2-local') headers['X-Segment-Prompts'] = JSON.stringify(requestPrompts);
      const response = await fetch(`http://127.0.0.1:4174/api/segment?adapter=${selectedAdapter}`, {
        method: 'POST', headers, body: imageBlob, signal: AbortSignal.timeout(180000),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || payload.error || '本机分割服务未就绪。');
      if (payload.status !== 'candidate-requires-human-review' || typeof payload.foregroundPngBase64 !== 'string' || typeof payload.reviewJpgBase64 !== 'string') throw new Error('本机服务返回了无法识别的候选。');
      if (selectedAdapter === 'sam2-local' && (!Array.isArray(payload.multimaskCandidates) || payload.multimaskCandidates.length !== 3 || payload.multimaskCandidates.some((item) => !Number.isInteger(item.index) || typeof item.pngBase64 !== 'string' || typeof item.score !== 'number'))) throw new Error('SAM 2 候选蒙版列表无效。');
      if (!requestIsCurrent()) throw new Error('分析期间分割方式、照片或点选已更改；旧请求已丢弃，请重新运行。');
      byId('segmentation-result-meta').textContent = `${payload.dimensions} · ${payload.inferenceSize} · 本机处理 ${Number(payload.requestSeconds).toFixed(2)} 秒（模型推理 ${Number(payload.inferenceSeconds).toFixed(2)} 秒）· 显存峰值 ${Number(payload.gpuPeakMemoryGiB).toFixed(2)} GiB`;
      segmentationPreviewPhoto = requestPhoto;
      segmentationVariants = selectedAdapter === 'sam2-local' ? payload.multimaskCandidates : [];
      const selectedVariant = segmentationVariants.find((item) => item.index === payload.chosenMultimaskIndex);
      if (selectedAdapter === 'sam2-local' && !selectedVariant) throw new Error('SAM 2 首选候选缺失。');
      await initializeSegmentationEditor(requestPhoto, selectedVariant?.pngBase64 || payload.foregroundPngBase64, selectedVariant?.alphaEdgeReview || payload.alphaEdgeReview,
        selectedVariant?.foregroundRegionReview || payload.foregroundRegionReview, selectedVariant?.promptReview || payload.promptReview,
        selectedVariant ? `SAM 2 候选 ${selectedVariant.index + 1} · 模型排序分数 ${Number(selectedVariant.score).toFixed(3)}；分数不代表人工质量批准。` : 'BiRefNet 自动分割蒙版；请人工检查。');
      if (!requestIsCurrent()) {
        segmentationPreviewPhoto = null;
        result.hidden = true;
        throw new Error('分析期间照片已更改，请重新运行透明主体预览。');
      }
      byId('segmentation-editor').hidden = true;
      byId('segmentation-edit-toggle').setAttribute('aria-expanded', 'false');
      const variantsView = byId('segmentation-variants');
      variantsView.replaceChildren();
      if (segmentationVariants.length) {
        variantsView.hidden = false;
        variantsView.append(document.createTextNode('SAM 2 候选蒙版 · 前景面积按整张画幅 alpha≥128 计算；点位检查看点击附近4 px。分数、边缘、面积和点位都只是启发式提示：'));
        [...segmentationVariants].sort((a, b) => b.score - a.score).forEach((variant) => {
          const variantButton = document.createElement('button');
          variantButton.type = 'button';
          variantButton.dataset.variantIndex = String(variant.index);
          variantButton.setAttribute('aria-pressed', String(variant.index === selectedVariant.index));
          const candidateLabel = document.createElement('span');
          candidateLabel.textContent = `候选 ${variant.index + 1} · ${variant.score.toFixed(3)}`;
          const cropSides = Array.isArray(variant.alphaEdgeReview?.possibleCropSides)
            ? variant.alphaEdgeReview.possibleCropSides.filter((side) => ({ left: true, right: true, top: true, bottom: true })[side]) : [];
          const sideLabels = { left: '左', right: '右', top: '上', bottom: '下' };
          const edgeLabel = document.createElement('small');
          edgeLabel.className = cropSides.length ? 'variant-edge-warning' : 'variant-edge-clear';
          edgeLabel.textContent = cropSides.length ? `${cropSides.map((side) => sideLabels[side]).join('、')}侧贴边` : '未检出贴边';
          const foregroundCoverage = Number(variant.alphaEdgeReview?.foregroundCoveragePercent);
          const areaLabel = document.createElement('small');
          if (Number.isFinite(foregroundCoverage)) {
            const areaWarning = foregroundCoverage < 10 || foregroundCoverage > 98;
            areaLabel.className = areaWarning ? 'variant-area-warning' : 'variant-area-normal';
            areaLabel.textContent = `前景 ${foregroundCoverage.toFixed(2)}%${foregroundCoverage < 10 ? ' · 覆盖偏少' : foregroundCoverage > 98 ? ' · 背景可能未除净' : ''}`;
          } else {
            areaLabel.className = 'variant-area-warning';
            areaLabel.textContent = '面积未测';
          }
          variantButton.append(candidateLabel, edgeLabel, areaLabel);
          const promptReview = variant.promptReview;
          const promptLabel = document.createElement('small');
          if (promptReview && Number.isInteger(promptReview.foregroundPointCount) && Number.isInteger(promptReview.backgroundPointCount)) {
            const missed = promptReview.foregroundPointMissedIndices?.length || 0;
            const retained = promptReview.backgroundPointForegroundIndices?.length || 0;
            const promptWarning = missed > 0 || retained > 0;
            promptLabel.className = promptWarning ? 'variant-area-warning' : 'variant-area-normal';
            promptLabel.textContent = `点位 正${promptReview.foregroundPointCount - missed}/${promptReview.foregroundPointCount} · 背景净${promptReview.backgroundPointCount - retained}/${promptReview.backgroundPointCount}${missed ? ` · 漏正点 ${missed}` : ''}${retained ? ` · 留背景 ${retained}` : ''}`;
          } else {
            promptLabel.className = 'variant-area-warning';
            promptLabel.textContent = '点位未评估';
          }
          variantButton.setAttribute('aria-label', `${candidateLabel.textContent}，${edgeLabel.textContent}，${areaLabel.textContent}，${promptLabel.textContent}；这些都是启发式检查，不代表蒙版质量通过`);
          variantButton.append(promptLabel);
          variantButton.addEventListener('click', async () => {
            variantButton.disabled = true;
            try { await selectSegmentationVariant(variant, requestPhoto); }
            catch (error) { byId('segmentation-status').textContent = `无法载入候选蒙版：${error.message}`; }
            finally { variantButton.disabled = false; }
          });
          variantsView.append(variantButton);
        });
      } else variantsView.hidden = true;
      if (selectedVariant) await selectSegmentationVariant(selectedVariant, requestPhoto);
      result.hidden = false;
      status.textContent = `${requestSource.photoName} · ${selectedAdapter === 'sam2-local' ? 'SAM 2 点选分割' : 'BiRefNet 自动分割'}候选已生成。请检查毛边、遮挡和画面裁切；模型不判断宠物身份或动画质量。此单图结果不会替换角色主照片。`;
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? '无法连接本机分割服务。请先按 tools/README.md 启动所选模型服务。'
        : error.name === 'TimeoutError'
          ? '本机分割请求超时，未生成候选。请检查 GPU 与服务状态后重试。'
          : `未能生成候选：${error.message}`;
    } finally {
      button.disabled = false;
      renderActionSuitability();
    }
  });
  byId('sam2-video-to-workshop').addEventListener('click', () => {
    const candidate = sam2VideoState.history.find((item) =>
      item.id === sam2VideoState.selectedCandidateId && item.sourceKey === sam2VideoState.sourceKey);
    if (!candidate || !sam2VideoState.file || candidate.reviewIssue || sam2VideoState.reviewSyncWarning) { tell('请先核对本机审核记录，并查看尚未标记需修改的候选。'); return; }
    if (!videoVisualReviewChecks.every((key) => candidate.visualReview?.checks.includes(key)) || !candidate.visualReview?.reviewedAt) {
      tell('请先在 190px 正常速度与完整边缘图中完成身份、动作、解剖、时序和边缘五项审核。'); return;
    }
    if (roleVideoContext && (!roleVideoContextIsCurrent() || !byId('sam2-video-role-confirm').checked)) {
      tell('角色计划已变化或视频身份尚未确认，请重新核对参考照片和动作。'); return;
    }
    activeReviewCandidate = normalizeRoleCandidate({ id: candidate.id, fps: candidate.fps,
      frameCount: candidate.frameCount, action: roleVideoContext?.action || currentAction });
    renderWorkshopCandidate();
    persistDraft();
    ui.start.click();
    tell('候选已带入当前角色草稿。请先核对照片身份，再到工坊检查动作和透明边缘。');
  });
  byId('workshop-candidate-remove').addEventListener('click', () => {
    activeReviewCandidate = null;
    renderWorkshopCandidate();
    persistDraft();
    tell('已从当前角色草稿移除动作候选；候选文件和对比记录仍保留在工作区。');
  });
  function wanAsset(id, filename) {
    if (!/^[a-f0-9]{32}$/.test(id) || !['clip.mp4', 'review-190px.png', 'motion-zoom.png', 'poster.png', 'anchor.png'].includes(filename))
      throw new Error('Wan 候选链接无效。');
    return `http://127.0.0.1:4179/api/review/${id}/${filename}`;
  }
  function wanChecksComplete() {
    return !!wanCandidate && !wanCandidate.reviewIssue && wanAnchorPhoto === photoSource && !byId('wan-anchor-review').hidden &&
      !byId('wan-anchor-confirm').disabled && byId('wan-anchor-confirm').checked && wanCandidate.photo === photoSource &&
      wanCandidate.action === currentAction &&
      wanCandidate.rolePrompt === byId('prompt-input').value.trim() &&
      (!wanCandidate.anchorFile || byId('wan-anchor-file').files?.[0] === wanCandidate.anchorFile) &&
      (!roleVideoContext || roleVideoContextIsCurrent()) &&
      [...document.querySelectorAll('[data-wan-check]')].every((input) => input.checked);
  }
  function invalidateWanCandidate() {
    wanCandidate = null;
    byId('wan-result').hidden = true;
    byId('wan-motion-focus').hidden = true;
    byId('wan-use').disabled = true;
  }
  async function blobBase64(blob) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('无法读取本机图像。'));
      reader.readAsDataURL(blob);
    });
    if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) throw new Error('图像编码失败。');
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }
  async function renderWanAnchorReview(file) {
    const panel = byId('wan-anchor-review');
    panel.hidden = true;
    byId('wan-anchor-confirm').checked = false;
    byId('wan-anchor-confirm').disabled = true;
    if (!file || file.type !== 'image/png' || file.size > 8 * 1024 * 1024) return;
    const url = URL.createObjectURL(file);
    try {
      const anchor = await imageFromSource(url);
      if (byId('wan-anchor-file').files?.[0] !== file) return;
      if (Math.min(anchor.naturalWidth, anchor.naturalHeight) < 128 ||
          Math.max(anchor.naturalWidth, anchor.naturalHeight) > 4096)
        throw new Error('透明锚图尺寸必须在 128–4096 px 之间。');
      const scan = document.createElement('canvas');
      scan.width = anchor.naturalWidth;
      scan.height = anchor.naturalHeight;
      const scanContext = scan.getContext('2d', { willReadFrequently: true });
      scanContext.drawImage(anchor, 0, 0);
      const pixels = scanContext.getImageData(0, 0, scan.width, scan.height).data;
      let transparent = 0;
      let borderOpaque = 0;
      let borderCount = 0;
      const band = Math.max(1, Math.round(Math.min(scan.width, scan.height) * 0.01));
      for (let y = 0; y < scan.height; y++) for (let x = 0; x < scan.width; x++) {
        const alpha = pixels[(y * scan.width + x) * 4 + 3];
        if (alpha === 0) transparent++;
        if (x < band || x >= scan.width - band || y < band || y >= scan.height - band) {
          borderCount++;
          if (alpha >= 240) borderOpaque++;
        }
      }
      if (transparent < scan.width * scan.height * 0.01)
        throw new Error('锚图几乎没有透明背景，请提供真正的 RGBA 主体。');
      for (const [id, background] of [['wan-anchor-warm', '#f4eee0'],
        ['wan-anchor-blue', '#b9d7ee'], ['wan-anchor-dark', '#272b31']]) {
        const canvas = byId(id);
        const context = canvas.getContext('2d');
        context.fillStyle = background;
        context.fillRect(0, 0, 190, 254);
        const scale = Math.min(176 / anchor.naturalWidth, 238 / anchor.naturalHeight);
        const width = anchor.naturalWidth * scale;
        const height = anchor.naturalHeight * scale;
        context.drawImage(anchor, (190 - width) / 2, (254 - height) / 2, width, height);
      }
      const strongEdgeContact = borderOpaque / borderCount >= 0.02;
      byId('wan-anchor-confirm').disabled = strongEdgeContact;
      byId('wan-anchor-review-note').textContent = strongEdgeContact
        ? '主体明显接触原画框，可能已经裁断；此锚图不能确认或提交生成。请换完整照片或重新制作有留白的锚图，修边不能补回画外身体。'
        : '检查与原照片是否同一只宠物；尤其查看胸腹接缝、爪子数量、尾巴与深色背景上的残边。';
      panel.hidden = false;
    } catch (error) {
      byId('wan-status').textContent = `无法审核透明锚图：${error.message}`;
    } finally { URL.revokeObjectURL(url); }
  }
  byId('wan-anchor-file').addEventListener('change', () => {
    wanAnchorPhoto = byId('wan-anchor-file').files?.[0] ? photoSource : null;
    renderWanAnchorReview(byId('wan-anchor-file').files?.[0]);
  });
  byId('wan-use-segmentation').addEventListener('click', async () => {
    const status = byId('wan-anchor-source-note');
    if (!fullBodyPhotoEligible()) {
      status.textContent = '当前照片尚未确认完整、无遮挡的单宠轮廓；原橘白猫照片右侧身体被裁切，不能用修边当作完整锚图。请补充完整照片。';
      return;
    }
    if (!segmentationEditor.canvas || byId('segmentation-result').hidden) {
      status.textContent = '请先在上方完成单图分割并检查透明候选。';
      return;
    }
    if (segmentationPreviewPhoto !== photoSource) {
      status.textContent = '当前透明候选不属于主照片；请选择主照片重新分割，再带入锚图。';
      return;
    }
    if (segmentationEditor.edgeReview?.possibleCropSides?.length ||
        segmentationEditor.regionReview?.possibleExtraForeground) {
      status.textContent = '分割候选提示裁切或额外前景；请换照片或修正候选，不能直接当作完整锚图。';
      return;
    }
    const sourceCanvas = segmentationEditor.canvas;
    const requestPhoto = photoSource;
    const requestRevision = segmentationCandidateRevision;
    const pixels = sourceCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
    const band = Math.max(1, Math.round(Math.min(sourceCanvas.width, sourceCanvas.height) * 0.01));
    let edgeOpaque = 0, edgeTotal = 0;
    let minX = sourceCanvas.width, minY = sourceCanvas.height, maxX = -1, maxY = -1;
    for (let y = 0; y < sourceCanvas.height; y++) for (let x = 0; x < sourceCanvas.width; x++) {
      const alpha = pixels[(y * sourceCanvas.width + x) * 4 + 3];
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (x < band || x >= sourceCanvas.width - band || y < band || y >= sourceCanvas.height - band) {
        edgeTotal++;
        if (alpha >= 240) edgeOpaque++;
      }
    }
    if (edgeOpaque / edgeTotal >= 0.02) {
      status.textContent = '当前透明主体仍明显贴边；修边无法恢复画外身体，请换完整照片。';
      return;
    }
    if (maxX < minX || maxY < minY) {
      status.textContent = '透明候选没有可见主体，请重新分割当前照片。';
      return;
    }
    const marginX = Math.max(8, Math.round((maxX - minX + 1) * 0.04));
    const marginY = Math.max(8, Math.round((maxY - minY + 1) * 0.04));
    const left = Math.max(0, minX - marginX), top = Math.max(0, minY - marginY);
    const right = Math.min(sourceCanvas.width, maxX + marginX + 1);
    const bottom = Math.min(sourceCanvas.height, maxY + marginY + 1);
    let anchorCanvas = sourceCanvas;
    if (right - left >= 128 && bottom - top >= 128 &&
        (right - left < sourceCanvas.width || bottom - top < sourceCanvas.height)) {
      anchorCanvas = document.createElement('canvas');
      anchorCanvas.width = right - left;
      anchorCanvas.height = bottom - top;
      anchorCanvas.getContext('2d').drawImage(sourceCanvas, left, top, anchorCanvas.width,
        anchorCanvas.height, 0, 0, anchorCanvas.width, anchorCanvas.height);
    }
    const button = byId('wan-use-segmentation');
    button.disabled = true;
    status.textContent = '正在裁去透明留白并绘制三背景 190px 预览……';
    try {
      const blob = await new Promise((resolve) => anchorCanvas.toBlob(resolve, 'image/png'));
      if (photoSource !== requestPhoto || segmentationCandidateRevision !== requestRevision ||
          segmentationEditor.canvas !== sourceCanvas || byId('segmentation-result').hidden || !fullBodyPhotoEligible()) {
        status.textContent = '准备期间照片或分割候选已变化；旧锚图已丢弃，请重新检查当前照片。';
        return;
      }
      if (!blob || !blob.size || blob.size > 8 * 1024 * 1024) {
        status.textContent = '透明单图候选超过 8 MB 或无法编码，请换图或缩小尺寸。';
        return;
      }
      const file = new File([blob], 'reviewed-single-photo-anchor.png', { type: 'image/png', lastModified: 0 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = byId('wan-anchor-file');
      input.files = transfer.files;
      wanAnchorPhoto = requestPhoto;
      invalidateWanCandidate();
      await renderWanAnchorReview(file);
      if (photoSource !== requestPhoto || input.files?.[0] !== file || byId('wan-anchor-review').hidden) {
        status.textContent = '透明锚图未完成当前照片的三背景审核，请重新选择候选。';
        return;
      }
      if (!byId('wan-source-coverage').value.trim())
        byId('wan-source-coverage').value = 'Full pet silhouette was photographed and manually confirmed; the transparent matte still requires edge and identity review.';
      status.textContent = '已带入当前照片的透明单图候选，并保留全部非透明像素、裁去透明留白；这不能补回画外身体。请在三背景 190px 预览中再次核对身份、爪子、尾巴和边缘，再确认。';
    } finally {
      button.disabled = false;
    }
  });
  function normalizeWanHistory(item) {
    if (!item || typeof item !== 'object' || !/^[a-f0-9]{32}$/.test(item.id) ||
        !/^[a-f0-9]{64}$/.test(item.photoKey) || !/^[a-f0-9]{64}$/.test(item.referenceSha256) ||
        !/^[a-f0-9]{64}$/.test(item.anchorSha256) || !['cat', 'dog'].includes(item.species) ||
        typeof item.action !== 'string' || typeof item.rolePrompt !== 'string' ||
        typeof item.positive !== 'string' || typeof item.negative !== 'string' ||
        typeof item.coverage !== 'string' || !Number.isInteger(item.seed) ||
        !['identity', 'anatomy', 'motion', 'timing', 'crop', 'edge', null].includes(item.reviewIssue ?? null)) return null;
    return { id: item.id, photoKey: item.photoKey, referenceSha256: item.referenceSha256,
      anchorSha256: item.anchorSha256, species: item.species, action: item.action,
      rolePrompt: item.rolePrompt.slice(0, 1200), positive: item.positive.slice(0, 4000),
      negative: item.negative.slice(0, 4000), coverage: item.coverage.slice(0, 500),
      seed: item.seed, createdAt: item.createdAt, reviewIssue: item.reviewIssue || null };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(wanHistoryKey) || '[]');
    if (Array.isArray(saved)) wanHistory = saved.map(normalizeWanHistory).filter(Boolean).slice(0, 12);
  } catch { wanHistory = []; }
  function saveWanHistory() {
    try { localStorage.setItem(wanHistoryKey, JSON.stringify(wanHistory.slice(0, 12))); return true; }
    catch { return false; }
  }
  wanHistoryPanel = document.createElement('section');
  wanHistoryPanel.className = 'wan-motion-history';
  wanHistoryPanel.hidden = true;
  document.querySelector('.wan-motion-panel').append(wanHistoryPanel);
  const wanRejectSelect = document.createElement('select');
  wanRejectSelect.setAttribute('aria-label', '选择 RGB 候选质量问题');
  wanRejectSelect.append(new Option('选择质量问题', ''));
  for (const [key, label] of Object.entries({ identity: '身份变化', anatomy: '解剖错误',
    motion: '动作不清楚', timing: '时序或循环断裂', crop: '画面裁切', edge: '原锚图接缝或异常边缘' }))
    wanRejectSelect.append(new Option(label, key));
  const wanRejectButton = document.createElement('button');
  wanRejectButton.type = 'button';
  wanRejectButton.className = 'secondary-button';
  wanRejectButton.textContent = '记录为需修改';
  const wanPoster = document.createElement('img');
  wanPoster.alt = '视频首帧静态封面，点击播放后按正常速度审核动作';
  wanPoster.hidden = true;
  const wanPlay = document.createElement('button');
  wanPlay.type = 'button';
  wanPlay.className = 'secondary-button';
  wanPlay.textContent = '播放正常速度视频';
  wanPlay.hidden = true;
  byId('wan-video').after(wanPoster, wanPlay);
  byId('wan-video').hidden = true;
  function showWanPoster(candidate) {
    byId('wan-video').pause();
    byId('wan-video').hidden = true;
    wanPoster.src = candidate.posterUrl;
    wanPoster.hidden = false;
    wanPlay.hidden = false;
  }
  function showWanMotionFocus(candidate) {
    const url = candidate.motionZoomUrl;
    const panel = byId('wan-motion-focus');
    if (url !== wanAsset(candidate.candidateId, 'motion-zoom.png')) {
      panel.hidden = true;
      return;
    }
    byId('wan-motion-zoom').src = url;
    byId('wan-motion-zoom-open').href = url;
    panel.hidden = false;
  }
  wanPlay.addEventListener('click', async () => {
    if (!wanCandidate) return;
    wanPlay.disabled = true;
    try {
      const video = byId('wan-video');
      video.playbackRate = 1;
      video.hidden = false;
      await video.play();
      wanPoster.hidden = true;
      wanPlay.hidden = true;
    } catch (error) {
      byId('wan-video').hidden = true;
      byId('wan-status').textContent = `无法播放正常速度视频：${error.message}`;
    } finally { wanPlay.disabled = false; }
  });
  byId('wan-result').append(wanRejectSelect, wanRejectButton);
  wanRejectButton.addEventListener('click', async () => {
    const candidate = wanCandidate;
    if (!candidate || !wanRejectSelect.value || candidate.reviewIssue) return;
    wanRejectButton.disabled = true;
    try {
      const response = await fetch('http://127.0.0.1:4179/api/reject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: candidate.candidateId, reason: wanRejectSelect.value }),
        signal: AbortSignal.timeout(10000),
      });
      const decision = await response.json();
      if (!response.ok || decision.candidateId !== candidate.candidateId || !decision.reviewIssue ||
          decision.installable !== false) throw new Error(decision.error || '本机拒绝记录未写入。');
      candidate.reviewIssue = decision.reviewIssue;
      wanHistory = wanHistory.map((item) => item.id === candidate.candidateId
        ? { ...item, reviewIssue: decision.reviewIssue } : item);
      saveWanHistory();
      byId('wan-use').disabled = true;
      byId('wan-status').textContent = `已在本机记录需修改（${wanRejectSelect.selectedOptions[0].textContent}）；此候选不能进入透明分割。可修改 Prompt 后重做。`;
      await renderWanHistory();
    } catch (error) {
      byId('wan-status').textContent = `无法保存拒绝记录：${error.message}`;
      wanRejectButton.disabled = false;
    }
  });
  async function renderWanHistory() {
    if (!wanHistoryPanel) return;
    const source = photoSource;
    const currentKey = await localSha256(new Blob([source]));
    if (photoSource !== source) return;
    const entries = wanHistory.filter((item) => item.photoKey === currentKey);
    wanHistoryPanel.hidden = entries.length === 0;
    wanHistoryPanel.replaceChildren();
    if (!entries.length) return;
    const title = document.createElement('h4');
    title.textContent = `这张照片的 RGB 候选 · ${entries.length}`;
    wanHistoryPanel.append(title);
    for (const item of entries) {
      const card = document.createElement('article');
      const review = document.createElement('img');
      review.src = wanAsset(item.id, 'review-190px.png');
      review.alt = '输入锚图与视频关键帧的 190px 对照';
      review.loading = 'lazy';
      const detail = document.createElement('span');
      detail.textContent = `${item.species === 'cat' ? '猫' : '狗'} · seed ${item.seed} · ${item.reviewIssue ? `需修改：${item.reviewIssue}` : '待 RGB 审核'} · ${item.id.slice(0, 8)}`;
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'secondary-button';
      select.textContent = '查看并比较';
      select.addEventListener('click', async () => {
        select.disabled = true;
        try {
          const response = await fetch(`http://127.0.0.1:4179/api/candidate/${item.id}`,
            { signal: AbortSignal.timeout(10000) });
          const state = await response.json();
          if (!response.ok || state.candidateId !== item.id || state.installable !== false ||
              state.referenceSha256 !== item.referenceSha256 || state.anchorSha256 !== item.anchorSha256 ||
              state.species !== item.species) throw new Error('本机候选来源无法核对。');
          if (photoSource !== source || await localSha256(new Blob([photoSource])) !== item.photoKey)
            throw new Error('当前照片已变化。');
          const anchorResponse = await fetch(wanAsset(item.id, 'anchor.png'),
            { signal: AbortSignal.timeout(10000) });
          if (!anchorResponse.ok || anchorResponse.headers.get('content-type') !== 'image/png')
            throw new Error('本机透明锚图不可用。');
          const anchorBlob = await anchorResponse.blob();
          if (!anchorBlob.size || anchorBlob.size > 8 * 1024 * 1024 ||
              await localSha256(anchorBlob) !== item.anchorSha256)
            throw new Error('透明锚图指纹无法核对。');
          const anchorFile = new File([anchorBlob], `wan-${item.id}-anchor.png`,
            { type: 'image/png', lastModified: 0 });
          const transfer = new DataTransfer();
          transfer.items.add(anchorFile);
          byId('wan-anchor-file').files = transfer.files;
          wanAnchorPhoto = source;
          invalidateWanCandidate();
          await renderWanAnchorReview(anchorFile);
          byId('wan-species').value = item.species;
          byId('wan-source-coverage').value = item.coverage;
          byId('wan-positive').value = item.positive;
          byId('wan-negative').value = item.negative;
          wanCandidate = { candidateId: item.id, model: 'Wan 2.2 TI2V-5B fp16', photo: source,
            action: item.action, rolePrompt: item.rolePrompt, species: item.species,
            referenceSha256: item.referenceSha256, anchorSha256: item.anchorSha256,
            positive: item.positive, negative: item.negative, coverage: item.coverage,
            seed: item.seed, reviewIssue: state.reviewIssue, anchorFile,
            clipUrl: wanAsset(item.id, 'clip.mp4'), reviewUrl: wanAsset(item.id, 'review-190px.png'),
            posterUrl: wanAsset(item.id, 'poster.png'), motionZoomUrl: state.motionZoomUrl };
          byId('wan-review').src = wanCandidate.reviewUrl;
          byId('wan-video').src = wanCandidate.clipUrl;
          byId('wan-video').poster = wanCandidate.posterUrl;
          showWanPoster(wanCandidate);
          showWanMotionFocus(wanCandidate);
          byId('wan-result').hidden = false;
          document.querySelectorAll('[data-wan-check]').forEach((input) => { input.checked = false; });
          byId('wan-use').disabled = true;
          wanRejectSelect.value = state.reviewIssue || '';
          wanRejectButton.disabled = !!state.reviewIssue;
          byId('wan-meta').textContent = `候选 ${item.id.slice(0, 8)} · seed ${item.seed} · 原照 ${item.referenceSha256.slice(0, 12)} · 锚图 ${item.anchorSha256.slice(0, 12)} · 未透明化、未安装`;
          byId('wan-status').textContent = state.reviewIssue
            ? `此候选已被标记需修改（${state.reviewIssue}），只能对比，不能继续分割。`
            : item.action !== currentAction || item.rolePrompt !== byId('prompt-input').value.trim()
              ? `历史 RGB 候选属于「${item.action}」和另一版角色描述，可比较；如需继续，请先恢复相同动作及描述，再完成四项视觉审核。`
              : '历史 RGB 候选已恢复。请与原照对照，并重新完成四项视觉审核。';
          byId('wan-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (error) { byId('wan-status').textContent = `无法读取历史候选：${error.message}`; }
        finally { select.disabled = false; }
      });
      card.append(review, detail, select);
      wanHistoryPanel.append(card);
    }
  }
  renderWanHistory();
  for (const id of ['wan-anchor-file', 'wan-species', 'wan-source-coverage', 'wan-positive', 'wan-negative']) {
    byId(id).addEventListener(id === 'wan-anchor-file' || id === 'wan-species' ? 'change' : 'input', invalidateWanCandidate);
  }
  document.querySelectorAll('[data-wan-check]').forEach((input) =>
    input.addEventListener('change', () => { byId('wan-use').disabled = !wanChecksComplete(); }));
  byId('wan-run').addEventListener('click', async () => {
    if (wanBusy) return;
    const status = byId('wan-status');
    const anchorFile = byId('wan-anchor-file').files?.[0];
    const species = byId('wan-species').value;
    const coverage = byId('wan-source-coverage').value.trim();
    const positive = byId('wan-positive').value.trim();
    const negative = byId('wan-negative').value.trim();
    const requestPhoto = photoSource;
    const requestAction = currentAction;
    const requestPrompt = byId('prompt-input').value.trim();
    if (mode === 'real' && requestAction === '打个招呼' && !sourceEvidence.includes('frontPaws')) {
      status.textContent = '真实宠物的抬爪招呼需要先在角色依据中确认前爪可见；请核对照片或换一个动作。';
      return;
    }
    if (byId('wan-anchor-confirm').disabled && !byId('wan-anchor-review').hidden) {
      status.textContent = '透明锚图明显贴边、可能已裁断；请换有完整留白的照片或锚图后再生成。';
      return;
    }
    if (!anchorFile || wanAnchorPhoto !== requestPhoto || anchorFile.type !== 'image/png' || !anchorFile.size || anchorFile.size > 8 * 1024 * 1024 ||
        byId('wan-anchor-review').hidden || byId('wan-anchor-confirm').disabled || !byId('wan-anchor-confirm').checked ||
        !['cat', 'dog'].includes(species) || coverage.length < 20 || coverage.length > 500 ||
        positive.length < 20 || positive.length > 4000 || negative.length < 20 || negative.length > 4000) {
      status.textContent = '请提供不超过 8 MB 的透明 PNG 锚图，完成三背景检查并确认，再填写物种、20–500 字来源说明及完整的正负 Prompt。';
      return;
    }
    if (roleVideoContext && !roleVideoContextIsCurrent()) {
      status.textContent = '角色照片或动作计划已变化，请从当前工坊重新进入视频制作。';
      return;
    }
    wanBusy = true;
    byId('wan-run').disabled = true;
    invalidateWanCandidate();
    let stage = '本机能力检查';
    try {
      status.textContent = '检查本机 Wan 服务；此时尚未发送照片……';
      const capabilityResponse = await fetch('http://127.0.0.1:4179/api/capabilities', { signal: AbortSignal.timeout(8000) });
      const capabilities = await capabilityResponse.json();
      if (!capabilityResponse.ok || capabilities.ready !== true || capabilities.task !== 'reference-and-rgba-anchor-to-rgb-video' ||
          capabilities.model !== 'Wan 2.2 TI2V-5B fp16' || !capabilities.species?.includes(species) ||
          capabilities.requiresSeparateRgbaAnchor !== true || capabilities.modelFilesVerifiedOnGeneration !== true ||
          capabilities.review?.required !== true || capabilities.review?.transparent !== false || capabilities.review?.installable !== false ||
          capabilities.privacy?.remoteNetworkUsed !== false || capabilities.privacy?.sourceImagesPersisted !== true ||
          capabilities.privacy?.candidateOutputsPersisted !== true)
        throw new Error('本机 Wan 服务或 ComfyUI 尚未就绪，或隐私与审核声明不符。');
      stage = '准备本机照片和锚图';
      const image = await imageFromSource(requestPhoto);
      const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const referenceBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!referenceBlob || referenceBlob.size > 8 * 1024 * 1024) throw new Error('参考照片超过本机输入上限。');
      const [referenceSha256, anchorSha256, referenceBase64, anchorBase64] = await Promise.all([
        localSha256(referenceBlob), localSha256(anchorFile), blobBase64(referenceBlob), blobBase64(anchorFile),
      ]);
      if (photoSource !== requestPhoto || currentAction !== requestAction || byId('prompt-input').value.trim() !== requestPrompt ||
          wanAnchorPhoto !== requestPhoto || byId('wan-anchor-file').files?.[0] !== anchorFile || !byId('wan-anchor-confirm').checked ||
          byId('wan-species').value !== species ||
          byId('wan-source-coverage').value.trim() !== coverage || byId('wan-positive').value.trim() !== positive ||
          byId('wan-negative').value.trim() !== negative)
        throw new Error('准备期间照片、锚图或 Prompt 已变化，请重新发起。');
      stage = '本机图生视频';
      status.textContent = '本机模型正在生成 RGB 视频，随后会制作 190px 待审图；不会自动批准或安装……';
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      const response = await fetch('http://127.0.0.1:4179/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ species, sourceCoverage: coverage, positive, negative, seed, length: 41, steps: 24,
          referenceBase64, anchorBase64 }), signal: AbortSignal.timeout(300000),
      });
      const candidate = await response.json();
      if (!response.ok) throw new Error(candidate.error || '本机图生视频失败。');
      if (photoSource !== requestPhoto || currentAction !== requestAction || byId('prompt-input').value.trim() !== requestPrompt ||
          wanAnchorPhoto !== requestPhoto || byId('wan-anchor-file').files?.[0] !== anchorFile || !byId('wan-anchor-confirm').checked ||
          byId('wan-species').value !== species ||
          byId('wan-source-coverage').value.trim() !== coverage || byId('wan-positive').value.trim() !== positive ||
          byId('wan-negative').value.trim() !== negative)
        throw new Error('生成期间角色或 Prompt 已变化；旧候选不会关联当前角色。');
      if (candidate.status !== 'candidate-requires-human-review' || candidate.model !== 'Wan 2.2 TI2V-5B fp16' ||
          !/^[a-f0-9]{32}$/.test(candidate.candidateId) || candidate.species !== species ||
          candidate.referenceSha256 !== referenceSha256 || candidate.anchorSha256 !== anchorSha256 ||
          candidate.sourceCoverage !== coverage || candidate.frameCount !== 41 || candidate.fps !== 24 ||
          candidate.transparent !== false || candidate.installable !== false || candidate.remoteNetworkUsed !== false ||
          candidate.sourceImagesPersisted !== true || candidate.clipUrl !== wanAsset(candidate.candidateId, 'clip.mp4') ||
          candidate.reviewUrl !== wanAsset(candidate.candidateId, 'review-190px.png') ||
          candidate.motionZoomUrl !== wanAsset(candidate.candidateId, 'motion-zoom.png') ||
          candidate.posterUrl !== wanAsset(candidate.candidateId, 'poster.png'))
        throw new Error('候选来源或审核状态无法验证。');
      wanCandidate = { ...candidate, photo: requestPhoto, action: requestAction, rolePrompt: requestPrompt,
        positive, negative, seed, anchorFile, coverage };
      const photoKey = await localSha256(new Blob([requestPhoto]));
      wanHistory = [normalizeWanHistory({ id: candidate.candidateId, photoKey,
        referenceSha256, anchorSha256, species, action: requestAction, rolePrompt: requestPrompt,
        positive, negative, coverage, seed, createdAt: new Date().toISOString(), reviewIssue: null }),
        ...wanHistory.filter((item) => item.id !== candidate.candidateId)].filter(Boolean).slice(0, 12);
      const historySaved = saveWanHistory();
      byId('wan-review').src = candidate.reviewUrl;
      byId('wan-video').src = candidate.clipUrl;
      byId('wan-video').poster = candidate.posterUrl;
      showWanPoster(wanCandidate);
      showWanMotionFocus(wanCandidate);
      byId('wan-result').hidden = false;
      document.querySelectorAll('[data-wan-check]').forEach((input) => { input.checked = false; });
      byId('wan-use').disabled = true;
      wanRejectSelect.value = '';
      wanRejectButton.disabled = false;
      byId('wan-meta').textContent = `${candidate.frameCount} 帧 · ${candidate.fps} fps · seed ${seed} · 原照 ${referenceSha256.slice(0, 12)} · 锚图 ${anchorSha256.slice(0, 12)} · 未透明化、未安装`;
      status.textContent = `RGB 候选已生成${historySaved ? '并记入本机对比记录' : '，但浏览器未能保存对比记录'}。请看完整视频和 190px 对照图；有身份、解剖、动作或裁切问题时不要勾选。`;
      await renderWanHistory();
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? '本机生成等待超时，请检查服务中的候选记录；没有安装任何素材。' :
        error instanceof TypeError ? `${stage}失败：无法连接本机服务。` : `${stage}失败：${error.message}`;
    } finally {
      wanBusy = false;
      byId('wan-run').disabled = false;
    }
  });
  byId('wan-use').addEventListener('click', async () => {
    const candidate = wanCandidate;
    if (!candidate || !wanChecksComplete() || candidate.photo !== photoSource || candidate.action !== currentAction ||
        candidate.rolePrompt !== byId('prompt-input').value.trim() ||
        (candidate.anchorFile && byId('wan-anchor-file').files?.[0] !== candidate.anchorFile) ||
        (roleVideoContext && !roleVideoContextIsCurrent())) {
      byId('wan-status').textContent = '角色计划或候选已变化，请重新审核当前结果。';
      return;
    }
    byId('wan-use').disabled = true;
    try {
      const reviewResponse = await fetch(`http://127.0.0.1:4179/api/candidate/${candidate.candidateId}`,
        { signal: AbortSignal.timeout(10000) });
      const reviewState = await reviewResponse.json();
      if (reviewState.reviewIssue) candidate.reviewIssue = reviewState.reviewIssue;
      if (!reviewResponse.ok || reviewState.reviewIssue || reviewState.installable !== false ||
          reviewState.referenceSha256 !== candidate.referenceSha256 ||
          reviewState.anchorSha256 !== candidate.anchorSha256)
        throw new Error('本机候选已被拒绝、不可用或来源指纹改变。');
      const response = await fetch(candidate.clipUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok || response.headers.get('content-type') !== 'video/mp4') throw new Error('本机候选视频不可用。');
      const blob = await response.blob();
      if (!blob.size || blob.size > 40 * 1024 * 1024) throw new Error('候选视频文件无效。');
      const photoKey = await localSha256(new Blob([photoSource]));
      if (wanCandidate !== candidate || candidate.photo !== photoSource || candidate.action !== currentAction)
        throw new Error('角色照片或候选已变化。');
      roleVideoContext = { photo: photoSource, action: currentAction, mode,
        name: ui.name.value.trim() || '小伙伴', prompt: candidate.rolePrompt,
        traits: normalizeTraits([...document.querySelectorAll('.trait-list input:checked')]
          .map((input) => traitLabelText(input.parentElement))),
        sourceEvidence: JSON.stringify(sourceEvidence), photoReview: JSON.stringify(photoReview), photoKey,
        sourceCandidate: { id: candidate.candidateId, composition: 'rgba-anchor-i2v', model: candidate.model } };
      renderRoleVideoContext();
      byId('sam2-video-fps').value = '25';
      const file = new File([blob], `wan-${candidate.candidateId}.mp4`, { type: 'video/mp4', lastModified: 0 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = byId('sam2-video-file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      byId('sam2-video-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
      byId('wan-status').textContent = 'RGB 视频已带入 SAM 2。继续逐帧分割，并在透明背景下重新完成五项审核。';
    } catch (error) {
      byId('wan-status').textContent = `无法带入透明分割：${error.message}`;
      byId('wan-use').disabled = !wanChecksComplete();
    }
  });
  byId('photo-wink-run').addEventListener('click', async () => {
    const button = byId('photo-wink-run');
    const status = byId('photo-wink-status');
    if (photoWinkBusy) {
      const requestId = photoWinkRequestId;
      const serverJobStarted = photoWinkServerJobStarted;
      status.textContent = serverJobStarted ? '正在停止本机推理；不会创建或安装候选……' : '已取消本机生成请求。';
      photoWinkController?.abort();
      if (serverJobStarted && /^[a-f0-9]{32}$/.test(requestId)) {
        fetch('http://127.0.0.1:4176/api/cancel-wink', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }), keepalive: true,
        }).catch(() => {});
      }
      return;
    }
    const requestLandmarkRoute = manualWinkSelected() ? 'manual-nine-point' : 'xpose-research';
    const requestManualPoints = requestLandmarkRoute === 'manual-nine-point' && manualFaceReady()
      ? manualFace.points.map((point) => [...point]) : null;
    const requestAnnotationCurrent = () => requestLandmarkRoute === 'xpose-research'
      ? xposeResearchConsent && !manualWinkSelected()
      : manualWinkSelected() && manualFaceReady() &&
        JSON.stringify(manualFace.points) === JSON.stringify(requestManualPoints);
    if (!requestAnnotationCurrent()) {
      status.textContent = requestLandmarkRoute === 'manual-nine-point'
        ? '请在当前照片上完成并确认九点面部标注。'
        : '请先查看并确认 X-Pose 官方许可证的非商业科研范围；确认前不会检查生成能力或发送照片。';
      return;
    }
    if (requestLandmarkRoute === 'xpose-research' && !xposeResearchConsent) {
      status.textContent = '请先查看并确认 X-Pose 官方许可证的非商业科研范围；确认前不会检查生成能力或发送照片。';
      return;
    }
    const requestPhoto = photoSource;
    const requestAction = currentAction;
    const requestEvidence = JSON.stringify(sourceEvidence);
    const requestPhotoReview = JSON.stringify(photoReview);
    const requestDrivingMultiplier = Number(byId('photo-wink-strength').value);
    const requestSourceScale = Number(byId('photo-wink-source-scale').value);
    const requestComposition = byId('photo-wink-preserve-body').checked ? 'full-image-pasteback' : 'face-crop';
    const requestFraming = byId('photo-wink-framing-review').hidden ? null : portraitFraming;
    const requestFramingCurrent = () => byId('photo-wink-framing-review').hidden
      ? !requestFraming
      : !!requestFraming && portraitFraming === requestFraming && portraitFramingIsCurrent() &&
        byId('photo-wink-framing-confirm').checked;
    const requestPlanTrace = aiWinkApplied && aiWinkApplied.drivingMultiplier === requestDrivingMultiplier &&
      aiWinkApplied.contextKey === JSON.stringify(aiPlanContext())
      ? { planId: aiWinkApplied.planId, promptSha256: aiWinkApplied.promptSha256,
        model: aiWinkApplied.model, motionIntensity: aiWinkApplied.motionIntensity } : null;
    const requestRoleContext = roleVideoContext;
    if (!Number.isFinite(requestDrivingMultiplier) || requestDrivingMultiplier < 0.5 || requestDrivingMultiplier > 2 || Math.abs(requestDrivingMultiplier * 20 - Math.round(requestDrivingMultiplier * 20)) > 1e-7 ||
        !Number.isFinite(requestSourceScale) || requestSourceScale < 2.3 || requestSourceScale > 3.2 || Math.abs(requestSourceScale * 10 - Math.round(requestSourceScale * 10)) > 1e-6) {
      status.textContent = '请选择有效的眨眼幅度和取景范围。';
      return;
    }
    if (requestAction !== '眨眨眼' || !isLocalPhoto(requestPhoto) || !sourceEvidence.includes('face') || photoReview.subjectCount !== 'one') {
      status.textContent = '本机单宠照片路线需要眨眼动作、可见脸部，并由你确认参考照片里只有一只宠物。';
      return;
    }
    if (requestComposition === 'full-image-pasteback' && !fullBodyPhotoEligible()) {
      status.textContent = '保留身体需要将完整照片设为主照片，并确认只有一只宠物、脸部和完整轮廓可见、无遮挡。';
      return;
    }
    if (!requestFramingCurrent() || (requestFraming && requestComposition !== 'full-image-pasteback')) {
      status.textContent = '当前主体取景未确认或已过期，请重新核对分割蒙版与原照。';
      return;
    }
    if (requestRoleContext && !roleVideoContextIsCurrent()) {
      status.textContent = '角色照片或动作计划已变化；请从当前工坊重新发起。';
      return;
    }
    const controller = new AbortController();
    photoWinkController = controller;
    photoWinkRequestId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    photoWinkServerJobStarted = false;
    photoWinkBusy = true;
    renderActionSuitability();
    let requestStage = '本机能力检查';
    try {
      status.textContent = '正在检查本机 LivePortrait 服务能力；尚未发送照片……';
      const capabilityResponse = await fetch(`http://127.0.0.1:4176/api/${requestLandmarkRoute === 'manual-nine-point' ? 'capabilities-manual' : 'capabilities'}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      const capabilities = await capabilityResponse.json();
      if (!capabilityResponse.ok) throw new Error('本机 LivePortrait 服务返回了无效的能力响应。');
      if (!capabilities.licenseTerms) throw new Error('当前 LivePortrait 服务版本未提供预期的许可声明；请重启桥接程序后重试。');
      if (capabilities.ready !== true || capabilities.task !== 'photo-to-wink-video' ||
          capabilities.model !== 'LivePortrait Animals v1.1' || !capabilities.actions?.includes('wink') ||
          !capabilities.compositions?.includes(requestComposition) ||
          capabilities.sourceCrop?.minimum !== 2.3 || capabilities.sourceCrop?.maximum !== 3.2 || capabilities.sourceCrop?.step !== 0.1 || capabilities.sourceCrop?.default !== 2.8 ||
          capabilities.review?.required !== true || capabilities.review?.transparent !== false || capabilities.review?.installable !== false ||
          capabilities.privacy?.remoteNetworkUsed !== false || capabilities.privacy?.sourceImagePersisted !== false ||
          capabilities.privacy?.candidateOutputsPersisted !== true ||
          capabilities.landmarkRoute !== requestLandmarkRoute ||
          (requestLandmarkRoute === 'manual-nine-point'
            ? capabilities.licenseTerms?.xposeUsed !== false || capabilities.licenseTerms?.distributionReviewRequired !== true
            : capabilities.license?.xpose !== 'non-commercial scientific research only; local experiment' ||
              capabilities.licenseTerms?.sourceUrl !== 'https://github.com/IDEA-Research/X-Pose/blob/master/LICENSE.txt' ||
              capabilities.licenseTerms?.permittedUse !== 'non-commercial scientific research' ||
              capabilities.licenseTerms?.nonTransferable !== true || capabilities.licenseTerms?.nonSublicensable !== true ||
              !['commercial', 'pornographic', 'military', 'surveillance'].every((purpose) => capabilities.licenseTerms?.prohibitedPurposes?.includes(purpose))))
        throw new Error('本机 LivePortrait 服务未就绪，或审核、隐私、许可声明不符合预期。');
      if (requestPlanTrace && (capabilities.planTrace?.supported !== true ||
          capabilities.planTrace?.model !== 'gpt-6-luna' ||
          capabilities.planTrace?.multipliers?.[requestPlanTrace.motionIntensity] !== requestDrivingMultiplier))
        throw new Error('本机眨眼服务尚未支持已应用的 AI 计划来源；请重启当前版本服务。');
      requestStage = '读取当前参考照片';
      if (!ui.photo.complete || !ui.photo.naturalWidth || ui.photo.currentSrc !== new URL(requestPhoto, document.baseURI).href)
        throw new Error('当前参考照片尚未载入，无法生成。');
      if (!requestFramingCurrent()) throw new Error('主体取景已变化，请重新准备。');
      const sourceCrop = requestFraming?.crop || [0, 0, ui.photo.naturalWidth, ui.photo.naturalHeight];
      const sourceWidth = sourceCrop[2] - sourceCrop[0];
      const sourceHeight = sourceCrop[3] - sourceCrop[1];
      const submittedManualPoints = requestManualPoints?.map(([x, y]) => [
        Number(((x * ui.photo.naturalWidth - sourceCrop[0]) / sourceWidth).toFixed(6)),
        Number(((y * ui.photo.naturalHeight - sourceCrop[1]) / sourceHeight).toFixed(6))]);
      if (submittedManualPoints?.some(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1))
        throw new Error('主体取景裁掉了已标注的面部点；请取消取景或重新标注。');
      const scale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法准备本机参考照片。');
      context.drawImage(ui.photo, sourceCrop[0], sourceCrop[1], sourceWidth, sourceHeight,
        0, 0, canvas.width, canvas.height);
      const photoBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
      if (!photoBlob) throw new Error('无法编码本机参考照片。');
      if (!photoBlob.size || photoBlob.size > 8 * 1024 * 1024) throw new Error('参考照片需小于 8 MB。');
      const requestPhotoKey = await portraitPhotoFingerprint(await portraitPhotoSourceBlob(requestPhoto));
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法读取当前参考照片。'));
        reader.readAsDataURL(photoBlob);
      });
      if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) throw new Error('参考照片编码失败。');
      if (!requestAnnotationCurrent() || !requestFramingCurrent() || photoSource !== requestPhoto || currentAction !== requestAction || JSON.stringify(sourceEvidence) !== requestEvidence || JSON.stringify(photoReview) !== requestPhotoReview || Number(byId('photo-wink-strength').value) !== requestDrivingMultiplier || Number(byId('photo-wink-source-scale').value) !== requestSourceScale || (byId('photo-wink-preserve-body').checked ? 'full-image-pasteback' : 'face-crop') !== requestComposition ||
          (requestRoleContext && (requestRoleContext !== roleVideoContext || !roleVideoContextIsCurrent())))
        throw new Error('处理期间角色照片、动作或可见范围已变化，请重新发起。');
      status.textContent = '正在本机生成眨眼视频；输出仍带原背景，完成后请先核对身份与动作……';
      requestStage = '发送照片并等待本机生成';
      photoWinkServerJobStarted = true;
      const response = await fetch(`http://127.0.0.1:4176/api/${requestLandmarkRoute === 'manual-nine-point' ? 'generate-manual-wink' : 'generate-wink'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: photoWinkRequestId, imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), drivingMultiplier: requestDrivingMultiplier, sourceScale: requestSourceScale,
          composition: requestComposition, fullSilhouetteConfirmed: requestComposition === 'full-image-pasteback',
          ...(requestLandmarkRoute === 'manual-nine-point'
            ? { manualLandmarks: submittedManualPoints, manualAnnotationConfirmed: true }
            : { licenseConsent: { accepted: true, sourceUrl: 'https://github.com/IDEA-Research/X-Pose/blob/master/LICENSE.txt', permittedUse: 'non-commercial scientific research' } }),
          ...(requestPlanTrace ? { planTrace: requestPlanTrace } : {}) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error === 'origin-not-allowed' ? '请从 localhost:4173 打开工作室。' : payload.error || '本机动作生成失败。');
      if (!requestAnnotationCurrent() || !requestFramingCurrent() || photoSource !== requestPhoto || currentAction !== requestAction || JSON.stringify(sourceEvidence) !== requestEvidence || JSON.stringify(photoReview) !== requestPhotoReview || Number(byId('photo-wink-strength').value) !== requestDrivingMultiplier || Number(byId('photo-wink-source-scale').value) !== requestSourceScale || (byId('photo-wink-preserve-body').checked ? 'full-image-pasteback' : 'face-crop') !== requestComposition ||
          (requestRoleContext && (requestRoleContext !== roleVideoContext || !roleVideoContextIsCurrent())))
        throw new Error('生成期间角色照片、动作或可见范围已变化；旧候选不会关联当前角色。');
      if (payload.status !== 'candidate-requires-human-review' || !/^[a-f0-9]{32}$/.test(payload.candidateId) ||
          payload.model !== 'LivePortrait Animals v1.1' || payload.action !== 'wink' || payload.landmarkRoute !== requestLandmarkRoute ||
          payload.composition !== requestComposition ||
          payload.drivingMultiplier !== requestDrivingMultiplier || payload.sourceScale !== requestSourceScale ||
          !Number.isInteger(payload.frameCount) || payload.frameCount < 2 || payload.frameCount > 120 ||
          payload.fps !== 25 || (requestComposition === 'face-crop'
            ? payload.canvas?.[0] !== 512 || payload.canvas?.[1] !== 512
            : !Number.isInteger(payload.canvas?.[0]) || !Number.isInteger(payload.canvas?.[1]) ||
              payload.canvas[0] < 256 || payload.canvas[0] > 1920 || payload.canvas[1] < 256 || payload.canvas[1] > 1920 ||
              Math.abs(payload.canvas[0] / payload.canvas[1] - canvas.width / canvas.height) > 0.02) ||
          !Number.isFinite(payload.generationSeconds) || payload.generationSeconds <= 0 ||
          payload.transparent !== false || payload.installable !== false || payload.remoteNetworkUsed !== false ||
          payload.sourceImagePersisted !== false || payload.licenseLimit !== (requestLandmarkRoute === 'manual-nine-point'
            ? 'Manual face annotation; model and dependency distribution review pending'
            : 'X-Pose: non-commercial scientific research only') ||
          JSON.stringify(payload.planTrace || null) !== JSON.stringify(requestPlanTrace) ||
          payload.clipUrl !== portraitReviewAsset(payload.candidateId, 'clip.mp4') ||
          payload.reviewUrl !== portraitReviewAsset(payload.candidateId, 'review-190px.jpg'))
        throw new Error('本机动作候选的来源、尺寸或审核状态无效。');
      const record = normalizePortraitCandidate({ id: payload.candidateId, photoKey: requestPhotoKey,
        action: 'wink', landmarkRoute: requestLandmarkRoute, frameCount: payload.frameCount, fps: payload.fps, drivingMultiplier: requestDrivingMultiplier, sourceScale: requestSourceScale, composition: requestComposition,
        generationSeconds: payload.generationSeconds, createdAt: new Date().toISOString(), planTrace: requestPlanTrace,
        ...(requestFraming ? { sourceCrop: requestFraming.crop, sourceSize: requestFraming.sourceSize } : {}) });
      if (!record) throw new Error('本机动作候选记录无效。');
      portraitPhotoKey = requestPhotoKey;
      portraitHistory = [record, ...portraitHistory.filter((item) => item.id !== record.id)].slice(0, 12);
      let historySaved = true;
      try { localStorage.setItem(portraitHistoryKey, JSON.stringify(portraitHistory)); }
      catch { historySaved = false; }
      showPortraitCandidate(record, requestPhoto);
      status.textContent = historySaved
        ? '眨眼候选已生成并记入本机对比记录。请核对身份和动作，再继续制作透明待审候选。'
        : '眨眼候选已生成，但浏览器未能保存对比记录；关闭页面后可从工作区找回视频文件。';
    } catch (error) {
      status.textContent = controller.signal.aborted ? '本机生成已取消；没有保留或安装候选。' :
        error.name === 'TimeoutError' ? '本机动作生成超时；没有安装任何素材。' :
        error instanceof TypeError ? `${requestStage}失败：${error.message}。请检查 LivePortrait 服务与当前照片。` : `未能生成眨眼候选：${error.message}`;
    } finally {
      photoWinkBusy = false;
      if (photoWinkController === controller) {
        photoWinkController = null;
        photoWinkRequestId = '';
        photoWinkServerJobStarted = false;
      }
      renderActionSuitability();
    }
  });
  byId('photo-wink-use').addEventListener('click', async () => {
    const button = byId('photo-wink-use');
    const status = byId('photo-wink-status');
    const candidate = photoWinkCandidate;
    if (!candidate || (candidate.landmarkRoute !== 'manual-nine-point' && !xposeResearchConsent) || candidate.photo !== photoSource || candidate.action !== currentAction || !sourceEvidence.includes('face') || photoReview.subjectCount !== 'one' ||
        (candidate.composition === 'full-image-pasteback' && !fullBodyPhotoEligible()) ||
        (roleVideoContext && !roleVideoContextIsCurrent())) {
      status.textContent = '角色照片、动作或脸部可见依据已变化；请重新核对当前角色的眨眼预览。';
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch(candidate.clipUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('本机生成视频已不可用。');
      const blob = await response.blob();
      if (blob.type !== 'video/mp4' || !blob.size || blob.size > 30 * 1024 * 1024) throw new Error('生成视频格式无效。');
      const photoKey = await localSha256(new Blob([photoSource]));
      if (photoWinkCandidate !== candidate || candidate.photo !== photoSource || candidate.action !== currentAction ||
          !sourceEvidence.includes('face') || photoReview.subjectCount !== 'one' ||
          (candidate.composition === 'full-image-pasteback' && !fullBodyPhotoEligible()))
        throw new Error('角色照片、动作或来源确认已变化。');
      roleVideoContext = { photo: photoSource, action: currentAction, mode,
        name: ui.name.value.trim() || '小伙伴', prompt: byId('prompt-input').value.trim(),
        traits: normalizeTraits([...document.querySelectorAll('.trait-list input:checked')]
          .map((input) => traitLabelText(input.parentElement))),
        sourceEvidence: JSON.stringify(sourceEvidence), photoReview: JSON.stringify(photoReview),
        photoKey, sourceCandidate: { id: candidate.candidateId, composition: candidate.composition,
          model: 'LivePortrait Animals v1.1' } };
      renderRoleVideoContext();
      byId('sam2-video-fps').value = '25';
      const file = new File([blob], `portrait-${candidate.candidateId}-wink.mp4`,
        { type: 'video/mp4', lastModified: 0 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const fileInput = byId('sam2-video-file');
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      byId('sam2-video-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
      status.textContent = '已带入本机生成的视频。请先核对它与角色照片的身份和动作，再点选前景制作透明候选。';
    } catch (error) {
      status.textContent = `无法带入分割流程：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  byId('sam2-video-choose').addEventListener('click', () => byId('sam2-video-file').click());
  byId('sam2-video-role-confirm').addEventListener('change', renderRoleVideoContext);
  byId('sam2-video-role-exit').addEventListener('click', () => {
    roleVideoContext = null;
    renderRoleVideoContext();
    tell('已退出角色动作制作；视频候选仍可单独审核。');
  });
  byId('sam2-video-file').addEventListener('change', async (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    const revision = ++sam2VideoState.selectionRevision;
    const selectionIsCurrent = () => revision === sam2VideoState.selectionRevision && input.files?.[0] === file;
    const player = byId('sam2-video-player');
    const sourcePanel = byId('sam2-video-source');
    const result = byId('sam2-video-result');
    result.hidden = true;
    sam2VideoState.file = null;
    sam2VideoState.firstFrame = null;
    sam2VideoState.sourceKey = '';
    sam2VideoState.selectedCandidateId = '';
    byId('sam2-video-role-confirm').checked = false;
    renderVideoHistory();
    sam2VideoState.foreground = [];
    sam2VideoState.background = [];
    byId('sam2-video-run').disabled = true;
    if (sam2VideoState.url) URL.revokeObjectURL(sam2VideoState.url);
    sam2VideoState.url = '';
    sourcePanel.hidden = true;
    if (!file) { updateSam2VideoFileInfo(); return; }
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['mp4', 'webm'].includes(extension) || file.size > 150 * 1024 * 1024) {
      updateSam2VideoFileInfo(file.size > 150 * 1024 * 1024 ? '视频文件不得超过 150 MB。' : '请选择 MP4 或 WebM 视频。');
      event.currentTarget.value = '';
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const metadata = waitForVideoEvent(player, 'loadedmetadata');
    player.src = objectUrl;
    player.load();
    try {
      await metadata;
      if (!selectionIsCurrent()) throw new Error('video-selection-changed');
      if (!Number.isFinite(player.duration) || !player.videoWidth || !player.videoHeight) throw new Error('视频没有有效的时长或画面尺寸。');
      if (player.readyState < 2) await waitForVideoEvent(player, 'loadeddata');
      if (!selectionIsCurrent()) throw new Error('video-selection-changed');
      byId('sam2-video-status').textContent = '正在本机核对视频内容指纹；不会上传原视频。';
      const sourceKey = await videoSourceKey(file);
      if (!selectionIsCurrent()) throw new Error('video-selection-changed');
      sam2VideoState.file = file;
      sam2VideoState.url = objectUrl;
      sam2VideoState.duration = player.duration;
      sam2VideoState.width = player.videoWidth;
      sam2VideoState.height = player.videoHeight;
      sam2VideoState.sourceKey = sourceKey;
      sam2VideoState.fps = Number(byId('sam2-video-fps').value);
      sam2VideoState.foreground = [];
      sam2VideoState.background = [];
      // Force a decoded first frame before the point canvas is drawn. Some
      // browsers report loadeddata while their paused video still paints black.
      await seekVideo(player, Math.min(0.01, player.duration / 4));
      await seekVideo(player, 0);
      if (!selectionIsCurrent()) throw new Error('video-selection-changed');
      const firstFrame = document.createElement('canvas');
      firstFrame.width = 512;
      firstFrame.height = 512;
      drawLetterboxedVideoFrame(player, firstFrame.getContext('2d'));
      sam2VideoState.firstFrame = firstFrame;
      sourcePanel.hidden = false;
      updateSam2VideoFileInfo();
      await syncVideoReviewDecisions(sam2VideoState.sourceKey);
      if (!selectionIsCurrent()) throw new Error('video-selection-changed');
      renderVideoHistory();
      byId('sam2-video-status').textContent = legacyVideoMatches(file)
        ? '旧版记录只按文件信息匹配，无法证明属于当前视频，因此未自动关联。请重新生成待审候选；原工作区文件仍保留。'
        : '请先查看视频，再在左侧画布的首帧点选宠物。只有点击“生成”后，抽取帧才会发送到本机服务。';
      renderSam2VideoPromptCanvas();
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      if (!selectionIsCurrent()) return;
      sam2VideoState.file = null;
      sam2VideoState.sourceKey = '';
      sam2VideoState.url = '';
      sourcePanel.hidden = true;
      updateSam2VideoFileInfo(`无法预览该视频：${error.message}`);
      player.removeAttribute('src');
      player.load();
    }
  });
  byId('sam2-video-fps').addEventListener('change', () => {
    sam2VideoState.fps = Number(byId('sam2-video-fps').value);
    updateSam2VideoFileInfo();
    renderSam2VideoPromptCanvas();
  });
  document.querySelectorAll('[data-video-point-label]').forEach((button) => button.addEventListener('click', () => {
    sam2VideoState.mode = button.dataset.videoPointLabel;
    document.querySelectorAll('[data-video-point-label]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
  }));
  byId('sam2-video-canvas').addEventListener('click', (event) => {
    if (!sam2VideoState.file || sam2VideoState.busy) return;
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const point = [
      Math.max(0, Math.min(511, Math.round((event.clientX - rect.left) * 512 / rect.width))),
      Math.max(0, Math.min(511, Math.round((event.clientY - rect.top) * 512 / rect.height))),
    ];
    const points = sam2VideoState[sam2VideoState.mode];
    if (sam2VideoState.foreground.length + sam2VideoState.background.length >= 32) return;
    points.push(point);
    renderSam2VideoPromptCanvas();
  });
  byId('sam2-video-clear-points').addEventListener('click', () => {
    sam2VideoState.foreground = [];
    sam2VideoState.background = [];
    renderSam2VideoPromptCanvas();
  });
  byId('sam2-video-run').addEventListener('click', async () => {
    const button = byId('sam2-video-run');
    const status = byId('sam2-video-status');
    const requestFile = sam2VideoState.file;
    const requestRoleContext = roleVideoContext;
    const fps = sam2VideoState.fps;
    if (!requestFile || !sam2VideoState.foreground.length || sam2VideoState.busy) return;
    if (roleVideoContext && (!roleVideoContextIsCurrent() || !byId('sam2-video-role-confirm').checked)) {
      status.textContent = '请先对照角色照片与视频，确认主体和动作计划；若角色草稿已改变，请重新从工坊发起。';
      return;
    }
    sam2VideoState.busy = true;
    button.disabled = true;
    byId('sam2-video-choose').disabled = true;
    byId('sam2-video-file').disabled = true;
    try {
      status.textContent = '正在连接本机 SAM 2.1 服务；此步骤只读取模型能力，不发送视频帧……';
      const capabilityResponse = await fetch('http://127.0.0.1:4175/api/capabilities');
      const capabilities = await capabilityResponse.json();
      if (!capabilityResponse.ok || capabilities.ready !== true || capabilities.task !== 'video-mask-propagation') throw new Error('SAM 2.1 视频服务未就绪；请按 tools/README.md 启动本机服务。');
      if (capabilities.privacy?.remoteNetworkUsed !== false || capabilities.privacy?.uploadedFramesPersisted !== false || capabilities.privacy?.candidateOutputsPersisted !== true || capabilities.capabilities?.requiresHumanReview !== true || capabilities.capabilities?.packageFormat !== 'little-orbit.theme' || capabilities.capabilities?.reviewDisposition !== 'content-addressed-local-veto' || capabilities.capabilities?.alphaMapping !== 'bounded-smoothstep-0.25') throw new Error('本机视频服务的隐私、审核或蒙版版本声明不符合预期，已停止发送帧。');
      const player = byId('sam2-video-player');
      const frames = await extractSam2VideoFrames(player, fps, requestFile);
      if (sam2VideoState.file !== requestFile) throw new Error('处理期间所选视频已更改。');
      if (requestRoleContext && (roleVideoContext !== requestRoleContext || !roleVideoContextIsCurrent() ||
          !byId('sam2-video-role-confirm').checked))
        throw new Error('抽帧期间角色计划或视频身份确认已变化；请重新从当前角色发起。');
      status.textContent = `正在本机传播 ${frames.length} 帧并构建待审主题包；只发送抽取出的静音画面，不发送原视频或音轨……`;
      const response = await fetch('http://127.0.0.1:4175/api/segment-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fps, frames, points: { positive: sam2VideoState.foreground, negative: sam2VideoState.background } }),
        signal: AbortSignal.timeout(180000),
      });
      const payload = await response.json();
      if (requestRoleContext && (roleVideoContext !== requestRoleContext || !roleVideoContextIsCurrent() ||
          !byId('sam2-video-role-confirm').checked))
        throw new Error('处理期间角色计划或视频身份确认已变化；候选未关联当前角色。');
      if (!response.ok) throw new Error(payload.error === 'origin-not-allowed' ? '请从 localhost:4173 打开工作室。' : payload.error === 'first-frame-positive-prompt-missed' ? '首帧分割没有包含所点前景。请在宠物脸部或身体内部多点几处，避开轮廓边缘后重试。' : payload.error === 'first-frame-mask-unstable' ? '首帧蒙版与后续帧差异过大，无法安全修复。请多点宠物脸部内部，或换一段开头较稳定的视频后重试。' : payload.detail || payload.error || '本机视频分割失败。');
      if (payload.status !== 'candidate-requires-human-review' || !/^[a-f0-9]{32}$/.test(payload.candidateId) ||
        payload.networkUsedForInference !== false || payload.uploadedFramesPersisted !== false || payload.candidateOutputsPersisted !== true ||
        ![null, 'motion', 'crop'].includes(payload.automaticVetoReason) ||
        payload.themePackage?.installable !== false || payload.themePackage?.review !== 'required' ||
        payload.themePackage?.frameCount !== payload.frameCount || payload.alphaMapping !== 'bounded-smoothstep-0.25' ||
        !normalizeBorderContact(payload.borderContact, payload.frameCount) ||
        !normalizeReviewSampling(payload.reviewSampling, payload.frameCount) || !Array.isArray(payload.canvas) ||
        payload.canvas[0] !== 512 || payload.canvas[1] !== 512) throw new Error('本机服务返回的候选审核状态不符合要求。');
      const reviewUrl = assertLocalVideoReviewUrl(payload.reviewUrl);
      const loopUrl = assertLocalVideoReviewUrl(payload.loopUrl);
      const packageUrl = assertLocalVideoReviewUrl(payload.packageUrl);
      if (reviewUrl !== videoReviewAsset(payload.candidateId, 'review-190px-warm-blue.jpg') ||
        loopUrl !== videoReviewAsset(payload.candidateId, 'review-190px-loop.gif') ||
        packageUrl !== videoReviewAsset(payload.candidateId, 'candidate.lotheme')) throw new Error('本机服务返回的候选链接不匹配。');
      const candidate = normalizeVideoCandidate({
        id: payload.candidateId,
        sourceKey: sam2VideoState.sourceKey,
        fps: payload.fps,
        frameCount: payload.frameCount,
        positiveCount: sam2VideoState.foreground.length,
        negativeCount: sam2VideoState.background.length,
        inferenceSeconds: payload.inferenceSeconds,
        peakCudaMemoryGiB: payload.peakCudaMemoryGiB,
        transparentPixels: payload.themePackage.transparentPixels,
        alphaMapping: payload.alphaMapping,
        borderContact: payload.borderContact,
        reviewSampling: payload.reviewSampling,
        automaticVetoReason: payload.automaticVetoReason,
        planSnapshot: requestRoleContext ? normalizeVideoPlanSnapshot(requestRoleContext) : null,
        createdAt: new Date().toISOString(),
      });
      if (!candidate || candidate.fps !== fps) throw new Error('本机服务返回的候选参数无效。');
      sam2VideoState.history = [candidate, ...sam2VideoState.history.filter((item) => item.id !== candidate.id)].slice(0, videoHistoryLimit);
      saveVideoHistory();
      await syncVideoReviewDecisions(sam2VideoState.sourceKey);
      displayVideoCandidate(candidate);
      status.textContent = candidate.automaticVetoReason
        ? candidate.automaticVetoReason === 'crop'
          ? '检测到主体持续接触多条画框边缘，候选已自动标记裁切；请更换取景或素材后重做，不能安装。'
          : `检测到严重蒙版跳变，候选已自动标记需修改；可查看第 ${candidate.reviewSampling?.worstFrames?.maskJump || '?'} 帧，但不能安装。`
        : `候选已生成并保存在工作区。上传帧已删除；候选包、透明帧和审核预览会保留在 generated/sam2-video-studio/${payload.candidateId}，可在审核后手动清理。`;
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? '本机分割超时。没有安装任何内容；可缩短动作片段后重试。' : error instanceof TypeError ? '无法连接本机视频服务；请按 tools/README.md 启动 SAM 2.1 视频服务。' : `未能生成视频候选：${error.message}`;
    } finally {
      sam2VideoState.busy = false;
      byId('sam2-video-choose').disabled = false;
      byId('sam2-video-file').disabled = false;
      renderSam2VideoPromptCanvas();
    }
  });
  byId('segmentation-edit-toggle').addEventListener('click', (event) => {
    const editor = byId('segmentation-editor');
    editor.hidden = !editor.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!editor.hidden));
  });
  document.querySelectorAll('[data-mask-mode]').forEach((button) => button.addEventListener('click', () => {
    segmentationEditor.mode = button.dataset.maskMode;
    document.querySelectorAll('[data-mask-mode]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
  }));
  byId('segmentation-brush').addEventListener('input', (event) => {
    byId('segmentation-brush-size').value = `${event.currentTarget.value} px`;
    byId('segmentation-brush-size').textContent = `${event.currentTarget.value} px`;
  });
  byId('segmentation-zoom').addEventListener('input', (event) => {
    const zoom = Number(event.currentTarget.value);
    byId('segmentation-zoom-value').value = `${zoom}%`;
    byId('segmentation-zoom-value').textContent = `${zoom}%`;
    if (segmentationEditor.canvas) segmentationEditor.canvas.style.width = `${zoom}%`;
  });
  byId('segmentation-canvas').addEventListener('pointerdown', (event) => {
    if (!segmentationEditor.canvas) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    segmentationEditor.activeStroke = [];
    segmentationEditor.lastPoint = segmentationCanvasPoint(event);
    applySegmentationBrush(segmentationEditor.lastPoint);
  });
  byId('segmentation-canvas').addEventListener('pointermove', (event) => {
    if (!segmentationEditor.activeStroke) return;
    const point = segmentationCanvasPoint(event);
    const previous = segmentationEditor.lastPoint;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const spacing = Math.max(2, Number(byId('segmentation-brush').value) * 0.38);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let index = 1; index <= steps; index++) {
      applySegmentationBrush({ x: previous.x + (point.x - previous.x) * index / steps, y: previous.y + (point.y - previous.y) * index / steps });
    }
    segmentationEditor.lastPoint = point;
  });
  byId('segmentation-canvas').addEventListener('pointerup', finishSegmentationStroke);
  byId('segmentation-canvas').addEventListener('pointercancel', finishSegmentationStroke);
  byId('segmentation-undo').addEventListener('click', () => {
    const stroke = segmentationEditor.undo.pop();
    if (!stroke || !segmentationEditor.canvas) return;
    segmentationCandidateRevision += 1;
    clearPortraitFraming();
    clearSegmentationPackageLink();
    const context = segmentationEditor.canvas.getContext('2d', { willReadFrequently: true });
    [...stroke].reverse().forEach((patch) => context.putImageData(patch.image, patch.x, patch.y));
    segmentationEditor.changed = segmentationEditor.undo.length > 0;
    byId('segmentation-edit-status').textContent = segmentationEditor.changed ? `已修整 · ${segmentationEditor.undo.length} 次可撤销` : '已撤销所有修整';
    byId('segmentation-undo').disabled = !segmentationEditor.undo.length;
    renderSegmentationReview();
    renderActionSuitability();
  });
  byId('segmentation-reset').addEventListener('click', () => {
    if (!segmentationEditor.canvas || !segmentationEditor.originalPixels) return;
    segmentationCandidateRevision += 1;
    clearPortraitFraming();
    clearSegmentationPackageLink();
    segmentationEditor.canvas.getContext('2d', { willReadFrequently: true }).putImageData(segmentationEditor.originalPixels, 0, 0);
    segmentationEditor.undo = [];
    segmentationEditor.changed = false;
    byId('segmentation-edit-status').textContent = '已重置为模型候选';
    byId('segmentation-undo').disabled = true;
    renderSegmentationReview();
    renderActionSuitability();
  });
  byId('add-reference-photos').addEventListener('click', () => byId('reference-photo-input').click());
  byId('photo-framing-add').addEventListener('click', () => byId('reference-photo-input').click());
  byId('reference-identity-confirm').addEventListener('change', () => {
    byId('reference-identity-apply').disabled = !pendingReferencePromotion || !byId('reference-identity-confirm').checked;
  });
  byId('reference-identity-cancel').addEventListener('click', () => byId('reference-photo-identity-dialog').close());
  byId('reference-identity-apply').addEventListener('click', applyReferencePromotion);
  byId('reference-photo-identity-dialog').addEventListener('close', () => {
    pendingReferencePromotion = null;
    byId('reference-identity-confirm').checked = false;
    byId('reference-identity-apply').disabled = true;
  });
  byId('reference-photo-input').addEventListener('change', async () => {
    const input = byId('reference-photo-input');
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const available = 3 - referencePhotos.length;
    if (available <= 0) { tell('一个角色最多保存三张补充照片。'); return; }
    const additions = [];
    try {
      for (const file of files.slice(0, available)) {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
          tell(`${file.name} 格式不支持或超过 8 MB，已跳过。`);
          continue;
        }
        const photo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('读取失败'));
          reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('图片无法解码'));
            image.onload = () => {
              const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
              canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
              const context = canvas.getContext('2d');
              if (!context) { reject(new Error('无法处理图片')); return; }
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL('image/jpeg', 0.82));
            };
            image.src = String(reader.result);
          };
          reader.readAsDataURL(file);
        });
        if (photo.length > 1_500_000) { tell(`${file.name} 优化后仍较大，已跳过。`); continue; }
        if (referencePhotos.some((item) => item.photo === photo) || additions.some((item) => item.photo === photo)) continue;
        additions.push({ photo, photoName: file.name.slice(0, 180) });
      }
      if (!additions.length) return;
      referencePhotos = normalizeReferencePhotos([...referencePhotos, ...additions]);
      if (JSON.stringify(currentProfile()).length > 3_800_000) {
        referencePhotos.splice(referencePhotos.length - additions.length, additions.length);
        renderReferencePhotos();
        tell('补充照片合计过大，无法安全保存在浏览器本地。请减少照片数量或尺寸。');
        return;
      }
      setSourceEvidence([]);
      setPhotoReview(undefined);
      renderReferencePhotos();
      persistDraft();
      tell(`已添加 ${additions.length} 张本地补充照片；生成模型目前仍只读取主照片。`);
    } catch (error) { tell(`补充照片未能载入：${error.message}`); }
  });
  ui.photoInput.addEventListener('change', () => {
    const file = ui.photoInput.files && ui.photoInput.files[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { tell('请选择 PNG、JPG 或 WebP 图片。'); return; }
    if (file.size > 8 * 1024 * 1024) { tell('照片超过 8 MB，请先选择较小的图片。'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      // Retain supported photo bytes so offline model drafts and saved points
      // bind to the same source. Larger inputs still require a resized source.
      const exactReference = await localSha256(file) === '112378a4bc93c8ae87aa71932f2309ddc41b6f3e3906c1e1e43701803409d209';
      if (ui.photoInput.files?.[0] !== file) return;
      const img = new Image();
      img.onload = () => {
        if (ui.photoInput.files?.[0] !== file) return;
        const preserveSourceBytes=exactReference || Math.max(img.naturalWidth,img.naturalHeight)<=4096;
        const maxEdge = 1600;
        const ratio = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
        const context = canvas.getContext('2d');
        if (!context) { tell('浏览器无法在本地优化这张图片，请换一张照片。'); return; }
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        photoSource = preserveSourceBytes ? String(reader.result) : canvas.toDataURL('image/webp', 0.9);
        photoName = file.name;
        referencePhotos = [];
        renderReferencePhotos();
        setPhotoReview(undefined);
        setSourceEvidence([]);
        if (activeReviewCandidate) {
          activeReviewCandidate = null;
          renderWorkshopCandidate();
        }
        byId('photo-framing-note').hidden = true;
        updateImages(photoSource);
        checkPhoto(preserveSourceBytes ? img.naturalWidth : canvas.width, preserveSourceBytes ? img.naturalHeight : canvas.height, Math.round(photoSource.length * 0.75), img);
        document.querySelectorAll('.trait-list input').forEach((box) => { box.checked = false; });
        tell(preserveSourceBytes ? '照片已在本地按原字节载入；旧动作候选已与草稿解除关联。请亲自确认身份特征。' : '大尺寸照片已在本地缩小并载入；原照片点位草稿不适用于缩小后的照片。旧动作候选已解除关联，请亲自确认身份特征。');
        persistDraft();
      };
      img.onerror = () => tell('这张图片无法读取，请换一个文件。');
      img.src = String(reader.result);
    };
    reader.onerror = () => tell('浏览器无法读取该照片。');
    reader.readAsDataURL(file);
  });
  ui.start.addEventListener('click', () => {
    byId('dialog-name').textContent = ui.name.value.trim() || '小伙伴';
    ui.dialogImage.src = photoSource;
    byId('workshop-heading').textContent = `给${ui.name.value.trim() || '小伙伴'}设计一个小动作`;
    setMode(mode, false);
    ui.creation.showModal();
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  byId('continue-to-workshop').addEventListener('click', () => {
    ui.creation.close();
    ui.workshop.showModal();
  });
  byId('workshop-to-video').addEventListener('click', async () => {
    const snapshot = { photo: photoSource, action: currentAction, mode,
      name: ui.name.value.trim() || '小伙伴', prompt: byId('prompt-input').value.trim(),
      traits: normalizeTraits([...document.querySelectorAll('.trait-list input:checked')].map((input) => traitLabelText(input.parentElement))),
      sourceEvidence: JSON.stringify(sourceEvidence), photoReview: JSON.stringify(photoReview) };
    const photoKey = await localSha256(new Blob([snapshot.photo]));
    roleVideoContext = { ...snapshot, photoKey };
    if (!roleVideoContextIsCurrent()) {
      roleVideoContext = null;
      tell('计算角色照片指纹期间草稿发生变化；请再次从当前工坊进入视频制作。');
      return;
    }
    byId('sam2-video-role-confirm').checked = false;
    refreshWanPositive(snapshot);
    persistDraft();
    ui.workshop.close();
    renderRoleVideoContext();
    byId('sam2-video-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    tell(currentAction === '眨眨眼' ? '已带入角色照片和动作计划。可在下方本机试做眨眼，或选择已有视频。' : '已带入角色照片和动作计划。请选已有动作视频并核对主体。');
  });
  byId('request-generation').addEventListener('click', async () => {
    if (!(await saveCharacter())) return;
    ui.workshop.close();
    ui.petDialog.showModal();
    tell(activeReviewCandidate ? '角色卡已记录待审动作候选；桌面仍显示静态照片，未安装候选。' : '角色卡已保存；当前打开的是静态照片预览。');
  });
  byId('pet-interact').addEventListener('click', () => {
    if (!preferences.interactionEnabled) { tell('本地点击互动已关闭，可在偏好设置中重新开启。'); return; }
    if (isQuietNow()) { tell(`现在是安静时段（${preferences.quietStart}–${preferences.quietEnd}），橘子会安静陪着你。`); return; }
    const figure = byId('pet-figure');
    const speech = byId('pet-speech');
    const responses = ['蹭蹭你的手', '眨眨眼看着你', '我在这里陪你'];
    speech.textContent = responses[Math.floor(Math.random() * responses.length)];
    figure.classList.remove('pet-bounce', 'speaking');
    void figure.offsetWidth;
    figure.classList.add('pet-bounce', 'speaking');
    window.setTimeout(() => figure.classList.remove('speaking'), 1600);
  });
  byId('pet-figure').addEventListener('click', () => byId('pet-interact').click());
  document.querySelectorAll('.nav-item[data-page]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item === button));
    const page = button.dataset.page;
    const label = { studio: '创作空间', characters: '我的角色', library: '动作素材', settings: '偏好设置' }[page];
    byId('breadcrumb-current').textContent = label;
    if (page === 'studio') {
      byId('studio-page').hidden = false;
      byId('characters-page').hidden = true;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (page === 'characters') {
      byId('studio-page').hidden = true;
      byId('characters-page').hidden = false;
      byId('archive-breadcrumb').textContent = label;
      renderCharacterLibrary();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (page === 'library') { byId('studio-page').hidden = false; byId('characters-page').hidden = true; ui.workshop.showModal(); return; }
    setSettingsForm();
    byId('settings-dialog').showModal();
    refreshLocalBackendStatus();
  }));
  byId('refresh-backend-status').addEventListener('click', refreshLocalBackendStatus);
  byId('new-character').addEventListener('click', startNewCharacter);
  byId('new-character-from-empty').addEventListener('click', () => {
    startNewCharacter();
  });
  byId('role-rollback-confirmed').addEventListener('change', (event) => {
    byId('confirm-role-rollback').disabled = !event.target.checked || !selectedRoleVersion;
  });
  byId('confirm-role-rollback').addEventListener('click', restorePreviousRoleVersion);
  byId('quiet-enabled').addEventListener('change', (event) => byId('quiet-time-fields').classList.toggle('enabled', event.target.checked));
  byId('frequency-range').addEventListener('input', (event) => {
    const text = `每 ${event.target.value} 分钟`;
    byId('frequency-value').value = text;
    byId('frequency-value').textContent = text;
  });
  byId('save-settings').addEventListener('click', () => {
    preferences = readSettingsForm();
    try {
      localStorage.setItem('littleOrbit.preferences', JSON.stringify(preferences));
      byId('settings-dialog').close();
      tell('陪伴偏好已保存在本地。');
    } catch { tell('浏览器存储不可用，偏好已应用到本次会话。'); }
  });
  function exactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
  }
  function parsePortablePreferences(data) {
    const rootKeys = ['kind', 'preferences', 'version'];
    const baseSettingKeys = ['frequencyMinutes', 'interactionEnabled', 'quietEnabled', 'quietEnd', 'quietStart'];
    const settingKeys = data?.version === 2 ? [...baseSettingKeys, 'automaticActionsEnabled'] : baseSettingKeys;
    const value = data?.preferences;
    const validTime = (text) => {
      if (typeof text !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return false;
      return true;
    };
    if (!exactKeys(data, rootKeys) || data.kind !== 'little-orbit.preferences' || ![1, 2].includes(data.version) ||
      !exactKeys(value, settingKeys) || typeof value.interactionEnabled !== 'boolean' || typeof value.quietEnabled !== 'boolean' ||
      data.version === 2 && typeof value.automaticActionsEnabled !== 'boolean' ||
      !validTime(value.quietStart) || !validTime(value.quietEnd) || !Number.isInteger(value.frequencyMinutes) ||
      value.frequencyMinutes < 5 || value.frequencyMinutes > 30 || value.frequencyMinutes % 5 !== 0) {
      throw new Error('文件版本、字段或偏好取值不符合规范。');
    }
    return { interactionEnabled: value.interactionEnabled,
      automaticActionsEnabled: data.version === 2 ? value.automaticActionsEnabled : false, quietEnabled: value.quietEnabled,
      quietStart: value.quietStart, quietEnd: value.quietEnd, frequencyMinutes: value.frequencyMinutes };
  }
  let preferencesExportUrl = null;
  function clearPreferencesExportLink() {
    preferencesExportUrl = null;
    byId('export-preferences-download').removeAttribute('href');
    byId('export-preferences-ready').hidden = true;
  }
  byId('settings-dialog').addEventListener('input', (event) => {
    if (event.target.matches('#interaction-enabled, #automatic-actions-enabled, #quiet-enabled, #quiet-start, #quiet-end, #frequency-range')) {
      clearPreferencesExportLink();
    }
  });
  byId('settings-dialog').addEventListener('change', (event) => {
    if (event.target.matches('#interaction-enabled, #automatic-actions-enabled, #quiet-enabled, #quiet-start, #quiet-end, #frequency-range')) {
      clearPreferencesExportLink();
    }
  });
  byId('export-preferences').addEventListener('click', () => {
    const payload = { kind: 'little-orbit.preferences', version: 2, preferences: readSettingsForm() };
    clearPreferencesExportLink();
    preferencesExportUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
    byId('export-preferences-download').href = preferencesExportUrl;
    byId('export-preferences-ready').hidden = false;
    tell('偏好备份已准备好；点击下载链接保存，再从桌面系统托盘导入。');
  });
  byId('import-preferences').addEventListener('click', () => byId('preferences-file').click());
  byId('preferences-file').addEventListener('change', () => {
    const input = byId('preferences-file'), file = input.files?.[0];
    if (!file) return;
    if (file.size > 64 * 1024) { tell('偏好备份超过 64 KiB，暂时无法导入。'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parsePortablePreferences(JSON.parse(String(reader.result)));
        setSettingsForm(imported);
        tell('偏好已载入设置表单；确认后按“保存偏好”应用。');
      } catch (error) { tell(`偏好导入失败：${error.message}`); }
      input.value = '';
    };
    reader.onerror = () => { tell('无法读取这份本地偏好备份。'); input.value = ''; };
    reader.readAsText(file);
  });
  async function embedPortablePng(source) {
    let imageSource = source;
    let objectUrl = '';
    if (!source.startsWith('data:image/')) {
      const response = await fetch(source);
      if (!response.ok) throw new Error('图片素材不可用');
      objectUrl = URL.createObjectURL(await response.blob());
      imageSource = objectUrl;
    }
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('图片读取失败'));
        element.src = imageSource;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法在本机转换图片格式');
      context.drawImage(image, 0, 0);
      const png = canvas.toDataURL('image/png');
      if (png.length > 11_200_000) throw new Error('角色照片转换后超过 8 MB，请换一张尺寸更小的照片');
      return png;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  async function embedPortableJpeg(source) {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('补充照片读取失败'));
      element.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法在本机转换补充照片');
    context.drawImage(image, 0, 0);
    const jpeg = canvas.toDataURL('image/jpeg', 0.84);
    if (jpeg.length > 1_500_000) throw new Error('补充照片转换后仍较大，请换一张尺寸较小的照片');
    return jpeg;
  }
  byId('export-card').addEventListener('click', async () => {
    const profile = currentProfile();
    try {
      profile.photo = await embedPortablePng(profile.photo);
      const character = { name: profile.name, mode: profile.mode, photo: profile.photo,
        photoName: profile.photoName, action: profile.action, prompt: profile.prompt,
        traits: profile.traits, sourceEvidence: profile.sourceEvidence,
        photoReview: normalizePhotoReview(profile.photoReview), referencePhotos: [] };
      if (profile.referencePhotos.length) {
        character.referencePhotos = await Promise.all(profile.referencePhotos.map(async (item) => ({
          photo: await embedPortableJpeg(item.photo), photoName: item.photoName,
        })));
      }
      const json = JSON.stringify({ kind: 'little-orbit.character-card', version: 4, status: 'draft', character }, null, 2);
      if (new Blob([json]).size > 12 * 1024 * 1024) throw new Error('角色卡包含的照片过多，请减少补充视角后再导出');
      const blob = new Blob([json], { type: 'application/json' });
      if (exportCardObjectUrl) URL.revokeObjectURL(exportCardObjectUrl);
      exportCardObjectUrl = URL.createObjectURL(blob);
      const safeName = profile.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) || 'pet';
      const anchor = byId('export-card-download');
      anchor.href = exportCardObjectUrl;
      anchor.download = `${safeName}.little-orbit.json`;
      byId('export-card-ready').hidden = false;
      tell('角色卡备份已准备好。请点击“下载角色卡备份”保存到本地。');
    } catch (error) { tell(`无法导出角色卡：${error.message}`); }
  });
  byId('import-card').addEventListener('click', () => byId('import-file').click());
  byId('import-file').addEventListener('change', () => {
    const file = byId('import-file').files?.[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { tell('备份文件超过 12 MB，暂时无法导入。'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const card = data?.character;
        const rootKeys = ['character', 'kind', 'status', 'version'];
        const cardKeys = ['action', 'mode', 'name', 'photo', 'photoName', 'prompt', 'traits'];
        const onlyKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(value, key));
        const validPhoto = card && (data.version === 1 && card.photo === fallbackPhoto || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(card.photo));
        const validTraits = card && Array.isArray(card.traits) && card.traits.length <= 3 && card.traits.every((trait) => typeof trait === 'string' && knownTraits.includes(trait.replace(/^[✓\s]+/u, '').trim())) && normalizeTraits(card.traits).length === card.traits.length;
        const legacyCard = data.version === 1 && (onlyKeys(card, cardKeys) || onlyKeys(card, [...cardKeys, 'reviewCandidate']) &&
          (card.reviewCandidate === null || normalizeRoleCandidate(card.reviewCandidate) !== null));
        const validReferencePhotos = (photos) => Array.isArray(photos) && photos.length <= 3 && photos.every((item) =>
          onlyKeys(item, ['photo', 'photoName']) && typeof item.photoName === 'string' && item.photoName.length <= 180 &&
          typeof item.photo === 'string' && item.photo.length <= 1_500_000 &&
          /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(item.photo));
        const currentCard = data.version === 2 && onlyKeys(card, [...cardKeys, 'sourceEvidence']) &&
          Array.isArray(card.sourceEvidence) && card.sourceEvidence.length <= evidenceParts.length &&
          card.sourceEvidence.every((part) => evidenceParts.includes(part)) &&
          normalizeSourceEvidence(card.sourceEvidence, card.photo).length === card.sourceEvidence.length;
        const multiPhotoCard = data.version === 3 && onlyKeys(card, [...cardKeys, 'sourceEvidence', 'referencePhotos']) &&
          Array.isArray(card.sourceEvidence) && card.sourceEvidence.length <= evidenceParts.length &&
          card.sourceEvidence.every((part) => evidenceParts.includes(part)) &&
          normalizeSourceEvidence(card.sourceEvidence, card.photo, card.referencePhotos).length === card.sourceEvidence.length &&
          validReferencePhotos(card.referencePhotos);
        const photoReviewCard = data.version === 4 && onlyKeys(card, [...cardKeys, 'sourceEvidence', 'referencePhotos', 'photoReview']) &&
          Array.isArray(card.sourceEvidence) && card.sourceEvidence.length <= evidenceParts.length &&
          card.sourceEvidence.every((part) => evidenceParts.includes(part)) &&
          normalizeSourceEvidence(card.sourceEvidence, card.photo, card.referencePhotos).length === card.sourceEvidence.length &&
          validReferencePhotos(card.referencePhotos) && onlyKeys(card.photoReview, ['subjectCount', 'occlusion']) &&
          ['one', 'multiple', 'uncertain'].includes(card.photoReview.subjectCount) &&
          ['clear', 'present', 'uncertain'].includes(card.photoReview.occlusion);
        if (!onlyKeys(data, rootKeys) || data.kind !== 'little-orbit.character-card' || !['draft', 'confirmed'].includes(data.status) ||
          !(legacyCard || currentCard || multiPhotoCard || photoReviewCard) || typeof card.name !== 'string' || !card.name.trim() || card.name.length > 18 ||
          !['real', 'original'].includes(card.mode) || !validPhoto || card.photo.length > 11_200_000 ||
          typeof card.photoName !== 'string' || card.photoName.length > 180 || typeof card.prompt !== 'string' || card.prompt.length > 1200 ||
          !['眨眨眼', '歪头看看', '打个招呼'].includes(card.action) || !validTraits) {
          throw new Error('备份版本、角色字段或照片格式不符合本地角色卡规范。');
        }
        ui.name.value = card.name;
        ui.nameCount.textContent = `${card.name.length} / 18`;
        photoSource = card.photo;
        photoName = card.photoName;
        referencePhotos = (multiPhotoCard || photoReviewCard) ? normalizeReferencePhotos(card.referencePhotos) : [];
        renderReferencePhotos();
        setPhotoReview(photoReviewCard ? card.photoReview : undefined);
        setSourceEvidence(currentCard || multiPhotoCard || photoReviewCard ? card.sourceEvidence : undefined);
        currentAction = card.action;
        mode = card.mode;
        byId('prompt-input').value = card.prompt;
        updateImages(photoSource);
        setMode(mode, false);
        setAction(currentAction, false);
        const importedTraits = normalizeTraits(card.traits);
        editingCharacterId = null;
        document.querySelectorAll('.trait-list label').forEach((label) => { label.querySelector('input').checked = importedTraits.includes(traitLabelText(label)); });
        const importedImage = new Image();
        importedImage.onload = () => checkPhoto(importedImage.naturalWidth, importedImage.naturalHeight, Math.round(card.photo.length * 0.75), importedImage);
        importedImage.onerror = () => tell('角色草稿已导入，但照片无法解码，请重新选择照片。');
        importedImage.src = card.photo;
        persistDraft();
        tell('备份已作为可编辑草稿导入。需要重新确认特征后才能保存角色卡。');
      } catch (error) { tell(`导入失败：${error.message}`); }
    };
    reader.onerror = () => tell('无法读取这份本地备份。');
    reader.readAsText(file);
  });
  byId('how-it-works').addEventListener('click', () => tell('流程：确认照片特征 → 选择动作 → 从照片试做眨眼或导入视频 → 透明分割与审核。开放式 Prompt 动作生成仍待接入。'));
  ui.nameCount.textContent = `${ui.name.value.length} / 18`;
  byId('dialog-name').textContent = ui.name.value.trim() || '小伙伴';
  document.querySelectorAll('.preview-caption').forEach((el) => { el.firstChild.textContent = ui.name.value.trim() || '小伙伴'; });
  byId('photo-caption-name').textContent = photoName;
  setSettingsForm();
  const currentPhotoBytes = () => photoSource === fallbackPhoto ? 455501 : Math.round(photoSource.length * 0.75);
  ui.photo.addEventListener('load', () => checkPhoto(ui.photo.naturalWidth, ui.photo.naturalHeight, currentPhotoBytes(), ui.photo));
  if (ui.photo.complete && ui.photo.naturalWidth) checkPhoto(ui.photo.naturalWidth, ui.photo.naturalHeight, currentPhotoBytes(), ui.photo);
  renderActionSuitability();
  portraitHistory = loadPortraitHistory();
  portraitHistoryLoaded = true;
  syncPortraitHistory(photoSource);
})();

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const video = $('sourceVideo'), canvas = $('previewCanvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const fileInput = $('fileInput'), emptyState = $('emptyState'), dropZone = $('dropZone');
  const image = new Image();
  let mediaKind = null, currentUrl = null, currentFile = null, exporting = false, drawing = null, rafId = 0, lastDraw = 0;
  let maskCanvas = document.createElement('canvas'), maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  let effectCanvas = document.createElement('canvas'), effectCtx = effectCanvas.getContext('2d');
  let cropMaskCanvas = document.createElement('canvas'), cropMaskCtx = cropMaskCanvas.getContext('2d', { willReadFrequently: true });
  let featherMaskCanvas = document.createElement('canvas'), featherMaskCtx = featherMaskCanvas.getContext('2d');
  let sourceCropCanvas = document.createElement('canvas'), sourceCropCtx = sourceCropCanvas.getContext('2d', { willReadFrequently: true });
  let selectionBounds = null, currentTool = 'rectangle', exportCanvas = null, exportCtx = null, recorder = null, exportStream = null, exportVideoTrack = null, recordedChunks = [], exportDuration = 0, exportAudioAvailable = false, recordingStartedAt = 0, recordedDurationMs = 0;
  let selectionRevision = 0, fillPlanCache = null;
  const brushCursor = $('brushCursor');
  let lastPointer = null, brushPreviewTimer = 0;
  function invalidateFillPlan() { selectionRevision++; fillPlanCache = null; }

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function setFillStatus(message) { $('fillStatus').textContent = message; }
  const fmtTime = secs => {
    if (!Number.isFinite(secs) || secs < 0) secs = 0;
    const s = Math.floor(secs), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
  };
  const setStatus = (msg, type='') => { $('statusBox').textContent = msg; $('statusBox').className = 'status' + (type ? ' ' + type : ''); };
  const activeEffect = () => document.querySelector('input[name="effect"]:checked').value;
  const hasVideo = () => mediaKind === 'video' && !!(video.src && video.videoWidth && video.videoHeight);
  const hasImage = () => mediaKind === 'image' && !!(image.naturalWidth && image.naturalHeight);
  const hasMedia = () => hasVideo() || hasImage();
  const sourceWidth = () => hasVideo() ? video.videoWidth : hasImage() ? image.naturalWidth : 0;
  const sourceHeight = () => hasVideo() ? video.videoHeight : hasImage() ? image.naturalHeight : 0;
  const sourceElement = () => hasVideo() ? video : image;
  const hasSelection = () => !!(selectionBounds && selectionBounds.w > 0 && selectionBounds.h > 0);

  function updateTransport() {
    if (!hasVideo()) return;
    $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    if (!video.seeking && Number.isFinite(video.duration) && video.duration > 0) {
      const value = String(Math.round(video.currentTime / video.duration * 1000));
      $('seekBarWide').value = value;
    }
    $('playBtn').textContent = video.paused ? '▶' : 'Ⅱ';
    $('playBtn').setAttribute('aria-label', video.paused ? 'Play video' : 'Pause video');
  }
  function updateSelectionUI() {
    $('clearSelectionBtn').disabled = !hasSelection() || exporting;
    $('exportBtn').disabled = !hasMedia() || !hasSelection() || exporting;
    if (!hasSelection()) {
      $('areaInfo').textContent = 'No area selected. Use Rectangle or Brush on the preview.';
      $('selectionHint').textContent = hasMedia() ? 'Mark the watermark in the preview.' : 'Select a media file to start.';
    } else {
      const b = selectionBounds;
      $('areaInfo').textContent = `${b.w} × ${b.h} px region at ${b.x}, ${b.y}. Brush adds selection and Erase removes it.`;
      $('selectionHint').textContent = `Selected region: ${b.w} × ${b.h} px`;
    }
  }
  function showEffectControls() {
    const effect = activeEffect();
    $('blurField').classList.toggle('hidden', effect !== 'blur');
    $('removeField').classList.toggle('hidden', effect !== 'remove');
    $('effectHint').textContent = effect === 'blur' ? 'Softens the selected shape so the watermark is unreadable. Works on any background.' : 'Uses a bundled WebAssembly diffusion-fill kernel, with a JavaScript fallback. Best for smaller watermarks; detailed textures may still show artifacts.';
  }
  function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('[data-tool]').forEach(btn => {
      const active = btn.dataset.tool === tool;
      btn.classList.toggle('active', active); btn.setAttribute('aria-pressed', String(active));
    });
    $('brushField').classList.toggle('hidden', tool === 'rectangle');
    $('toolHint').textContent = tool === 'rectangle'
      ? 'Drag to draw a rectangular selection. A new rectangle replaces the current selection.'
      : tool === 'brush'
        ? 'Paint over the watermark to add to the selected area. You can paint multiple strokes.'
        : 'Paint over a selected area to remove it from the selection. This does not erase the original media.';
    canvas.style.cursor = cursorFor(tool);
    updateBrushCursor(lastPointer);
  }
  function makeCanvases(width, height) {
    canvas.width = width; canvas.height = height;
    maskCanvas.width = width; maskCanvas.height = height;
    maskCtx.clearRect(0,0,width,height);
    invalidateFillPlan();
    selectionBounds = null; drawing = null;
    canvas.style.display = 'block'; emptyState.style.display = 'none';
    updateSelectionUI();
  }
  function updateMediaUI() {
    if (!hasMedia()) return;
    const w = sourceWidth(), h = sourceHeight();
    $('fileMeta').textContent = `${mediaKind === 'image' ? 'Image' : 'Video'} · ${currentFile ? currentFile.name : 'Media'}`;
    $('sizeHint').textContent = `${w} × ${h} px · ${mediaKind === 'image' ? 'PNG export' : 'WebM export'}`;
    $('videoTransport').classList.toggle('hidden', mediaKind !== 'video');
    $('exportBtn').textContent = mediaKind === 'image' ? 'Process & download PNG' : 'Process & export video';
    $('playBtn').disabled = !hasVideo(); $('seekBarWide').disabled = !hasVideo();
    updateSelectionUI();
    if (hasImage() || (hasVideo() && video.readyState >= 2)) drawProcessed(ctx, canvas, true);
  }
  function clearMask() {
    if (exporting) return;
    if (maskCanvas.width && maskCanvas.height) maskCtx.clearRect(0,0,maskCanvas.width,maskCanvas.height);
    invalidateFillPlan();
    selectionBounds = null; drawing = null; updateSelectionUI();
    if (hasMedia()) drawProcessed(ctx, canvas, true);
  }
  function mergeBounds(a, b) {
    if (!a) return {...b};
    const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y), r = Math.max(a.x+a.w,b.x+b.w), bot = Math.max(a.y+a.h,b.y+b.h);
    return {x,y,w:r-x,h:bot-y};
  }
  // The brush slider is in on-screen pixels so the brush looks the same size on
  // any image; convert to image pixels using the canvas' current display scale.
  function brushPx() {
    const r = canvas.getBoundingClientRect();
    const scale = r.width > 0 ? canvas.width / r.width : 1;
    return Math.max(1, Number($('brushSize').value) * scale);
  }
  function cursorFor(tool) { return tool === 'rectangle' ? 'crosshair' : 'none'; }
  function updateBrushCursor(evt) {
    const show = evt && evt.pointerType !== 'touch' && (currentTool === 'brush' || currentTool === 'erase') && hasMedia() && !exporting;
    if (!show) { brushCursor.style.display = 'none'; return; }
    const d = Number($('brushSize').value);
    brushCursor.style.width = brushCursor.style.height = d + 'px';
    brushCursor.style.left = evt.clientX + 'px'; brushCursor.style.top = evt.clientY + 'px';
    brushCursor.classList.toggle('erase', currentTool === 'erase');
    brushCursor.style.display = 'block';
  }
  // Flash the brush outline in the middle of the preview while the size changes.
  function previewBrushSize() {
    if (currentTool === 'rectangle' || !hasMedia()) return;
    if (lastPointer) { updateBrushCursor(lastPointer); return; }
    const r = canvas.getBoundingClientRect();
    updateBrushCursor({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse' });
    clearTimeout(brushPreviewTimer);
    brushPreviewTimer = setTimeout(() => { if (!lastPointer) updateBrushCursor(null); }, 800);
  }
  function includeBrushBounds(p) {
    const rad = brushPx() / 2;
    const b = {x:clamp(Math.floor(p.x-rad),0,canvas.width),y:clamp(Math.floor(p.y-rad),0,canvas.height),w:0,h:0};
    const r = clamp(Math.ceil(p.x+rad),0,canvas.width), bot = clamp(Math.ceil(p.y+rad),0,canvas.height);
    b.w = Math.max(0,r-b.x); b.h = Math.max(0,bot-b.y);
    if (b.w && b.h) selectionBounds = mergeBounds(selectionBounds,b);
  }
  function paintStroke(from, to, erase=false) {
    const size = brushPx();
    maskCtx.save(); maskCtx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    maskCtx.strokeStyle = '#8ce6d0'; maskCtx.fillStyle = '#8ce6d0'; maskCtx.lineWidth = size;
    maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';
    maskCtx.beginPath(); maskCtx.moveTo(from.x,from.y); maskCtx.lineTo(to.x,to.y); maskCtx.stroke();
    if (from.x === to.x && from.y === to.y) { maskCtx.beginPath(); maskCtx.arc(from.x,from.y,size/2,0,Math.PI*2); maskCtx.fill(); }
    maskCtx.restore();
    if (!erase) { includeBrushBounds(from); includeBrushBounds(to); }
  }
  function recomputeBounds() {
    if (!selectionBounds) return;
    const x0=clamp(Math.floor(selectionBounds.x),0,maskCanvas.width), y0=clamp(Math.floor(selectionBounds.y),0,maskCanvas.height);
    const w0=clamp(Math.ceil(selectionBounds.w),0,maskCanvas.width-x0), h0=clamp(Math.ceil(selectionBounds.h),0,maskCanvas.height-y0);
    if (!w0 || !h0) { selectionBounds=null; return; }
    const data=maskCtx.getImageData(x0,y0,w0,h0).data;
    let minX=w0,minY=h0,maxX=-1,maxY=-1;
    for(let y=0;y<h0;y++) for(let x=0;x<w0;x++) if(data[(y*w0+x)*4+3]>4){if(x<minX)minX=x;if(y<minY)minY=y;if(x>maxX)maxX=x;if(y>maxY)maxY=y;}
    selectionBounds=maxX<0 ? null : {x:x0+minX,y:y0+minY,w:maxX-minX+1,h:maxY-minY+1};
  }
  function canvasPoint(evt) {
    const r=canvas.getBoundingClientRect();
    return {x:clamp((evt.clientX-r.left)*(canvas.width/r.width),0,canvas.width),y:clamp((evt.clientY-r.top)*(canvas.height/r.height),0,canvas.height)};
  }
  function ensureLocalCanvases(w,h) {
    for(const c of [effectCanvas,cropMaskCanvas,featherMaskCanvas]) if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  }
  function drawProcessed(targetCtx, targetCanvas, includeOverlay) {
    if (!hasMedia() || !targetCanvas.width || !targetCanvas.height) return;
    const w=targetCanvas.width,h=targetCanvas.height,source=sourceElement();
    targetCtx.save(); targetCtx.setTransform(1,0,0,1,0,0); targetCtx.filter='none'; targetCtx.globalAlpha=1; targetCtx.globalCompositeOperation='source-over';
    targetCtx.clearRect(0,0,w,h); targetCtx.drawImage(source,0,0,w,h);
    // Avoid running the fill algorithm on every pointer-move while the user
    // is painting or erasing. The selected preview is refreshed on pointer-up.
    if(hasSelection() && !(includeOverlay && drawing)) {
      const feather=Number($('featherAmount').value),blur=activeEffect()==='blur'?Number($('blurAmount').value):0;
      const removePad = activeEffect()==='remove' ? 16 : 2;
      const pad=Math.max(removePad,Math.ceil(feather*3),Math.ceil(blur*2));
      const b={x:Math.max(0,selectionBounds.x-pad),y:Math.max(0,selectionBounds.y-pad),w:0,h:0};
      const ex=Math.min(w,selectionBounds.x+selectionBounds.w+pad),ey=Math.min(h,selectionBounds.y+selectionBounds.h+pad);b.w=ex-b.x;b.h=ey-b.y;
      if(b.w>0&&b.h>0){
        ensureLocalCanvases(b.w,b.h);
        effectCtx.setTransform(1,0,0,1,0,0);effectCtx.globalAlpha=1;effectCtx.globalCompositeOperation='source-over';effectCtx.filter='none';effectCtx.clearRect(0,0,b.w,b.h);
        cropMaskCtx.setTransform(1,0,0,1,0,0);cropMaskCtx.clearRect(0,0,b.w,b.h);cropMaskCtx.drawImage(maskCanvas,b.x,b.y,b.w,b.h,0,0,b.w,b.h);
        if(activeEffect()==='blur'){
          const p=Math.ceil(blur*2),sx=Math.max(0,b.x-p),sy=Math.max(0,b.y-p),ex2=Math.min(w,b.x+b.w+p),ey2=Math.min(h,b.y+b.h+p);
          effectCtx.filter=`blur(${blur}px)`;
          effectCtx.drawImage(source,sx,sy,ex2-sx,ey2-sy,sx-b.x,sy-b.y,ex2-sx,ey2-sy);
          effectCtx.filter='none';
        } else {
          sourceCropCanvas.width=b.w; sourceCropCanvas.height=b.h;
          sourceCropCtx.setTransform(1,0,0,1,0,0); sourceCropCtx.clearRect(0,0,b.w,b.h);
          sourceCropCtx.drawImage(source,b.x,b.y,b.w,b.h,0,0,b.w,b.h);
          const planKey = `${selectionRevision}:${b.x}:${b.y}:${b.w}:${b.h}`;
          if(!fillPlanCache || fillPlanCache.key !== planKey){
            fillPlanCache = {key:planKey, plan:window.LocalWatermarkInpaint.buildPlan(cropMaskCtx,b.w,b.h)};
          }
          const ok = window.LocalWatermarkInpaint.applyPlan(sourceCropCtx,effectCtx,fillPlanCache.plan,Number($('fillPasses').value));
          if(!ok) { effectCtx.drawImage(source,b.x,b.y,b.w,b.h,0,0,b.w,b.h); }
        }
        let usedMask=cropMaskCanvas;
        if(feather>0){
          featherMaskCtx.setTransform(1,0,0,1,0,0);featherMaskCtx.clearRect(0,0,b.w,b.h);featherMaskCtx.filter=`blur(${feather}px)`;featherMaskCtx.drawImage(cropMaskCanvas,0,0);featherMaskCtx.filter='none';usedMask=featherMaskCanvas;
        }
        effectCtx.globalCompositeOperation='destination-in';effectCtx.drawImage(usedMask,0,0);effectCtx.globalCompositeOperation='source-over';
        targetCtx.drawImage(effectCanvas,b.x,b.y);
      }
    }
    if(includeOverlay&&hasSelection()){
      const b=selectionBounds;targetCtx.save();targetCtx.globalAlpha=.25;targetCtx.drawImage(maskCanvas,b.x,b.y,b.w,b.h,b.x,b.y,b.w,b.h);targetCtx.restore();
    }
    if(includeOverlay&&drawing&&drawing.kind==='rect'){
      const p=drawing.start,q=drawing.current,x=Math.min(p.x,q.x),y=Math.min(p.y,q.y),rw=Math.abs(q.x-p.x),rh=Math.abs(q.y-p.y);
      targetCtx.save();targetCtx.fillStyle='rgba(140,230,208,.16)';targetCtx.fillRect(x,y,rw,rh);targetCtx.strokeStyle='#a5f5e3';targetCtx.lineWidth=Math.max(2,w/700);targetCtx.setLineDash([Math.max(5,w/120),Math.max(3,w/200)]);targetCtx.strokeRect(x+.5,y+.5,rw,rh);targetCtx.restore();
    }
    targetCtx.restore();
  }
  function renderLoop(ts) {
    rafId=requestAnimationFrame(renderLoop);
    if(!hasVideo()||video.readyState<2)return;
    if(exporting&&ts-lastDraw<33)return;
    // A paused preview is redrawn by the seek/selection/slider handlers, so the
    // loop does not need to re-run the fill on an unchanged frame.
    if(video.paused&&!exporting)return;
    lastDraw=ts;
    if(exporting&&exportCtx&&exportCanvas){
      // Render only the export while recording. Running the expensive fill twice
      // per frame (preview plus export) can starve decoding and make playback stutter.
      drawProcessed(exportCtx,exportCanvas,false);
      // In manual-capture mode, record only a newly rendered frame instead of
      // repeatedly recording stale canvas frames while processing is busy.
      if(exportVideoTrack&&typeof exportVideoTrack.requestFrame==='function'){
        try{exportVideoTrack.requestFrame();}catch(e){}
      }
    }else{
      drawProcessed(ctx,canvas,true);
    }
    updateTransport();
  }
  function onMediaReady() {
    const w=sourceWidth(),h=sourceHeight();
    if(!w||!h){setStatus('This media file could not be decoded by your browser. Try a common image format or H.264 MP4/WebM video.','error');return;}
    makeCanvases(w,h);updateMediaUI();setStatus(`${mediaKind==='image'?'Image':'Video'} loaded locally. Choose Rectangle or Brush and mark the watermark.`, 'success');
    if(hasVideo())updateTransport();
  }
  function useFile(file) {
    if(!file)return;
    if(exporting){setStatus('Wait for the current export to finish before changing media.','error');return;}
    const kind=file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':null;
    if(!kind){setStatus('Please choose an image or video file.','error');return;}
    currentFile=file;mediaKind=kind;selectionBounds=null;drawing=null;
    if(currentUrl)URL.revokeObjectURL(currentUrl);
    currentUrl=URL.createObjectURL(file);maskCanvas.width=maskCanvas.height=0;
    canvas.style.display='none';emptyState.style.display='grid';$('fileMeta').textContent=`Loading ${kind}…`;$('videoTransport').classList.toggle('hidden',kind!=='video');
    if(kind==='video'){
      image.onload=null;image.onerror=null;video.pause();video.src=currentUrl;video.load();setStatus('Loading video locally…');
    }else{
      video.pause();video.removeAttribute('src');video.load();
      const thisUrl=currentUrl;image.onload=()=>{if(thisUrl!==currentUrl)return;onMediaReady();};image.onerror=()=>{if(thisUrl===currentUrl)setStatus('This image could not be opened. Try PNG, JPEG, or WebP.','error');};image.src=currentUrl;setStatus('Loading image locally…');
    }
    updateSelectionUI();
  }
  canvas.addEventListener('pointerdown',e=>{
    if(!hasMedia()||exporting)return;if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();canvas.setPointerCapture(e.pointerId);const p=canvasPoint(e);invalidateFillPlan();
    if(currentTool==='rectangle'){
      maskCtx.clearRect(0,0,maskCanvas.width,maskCanvas.height);selectionBounds=null;drawing={kind:'rect',start:p,current:p};
    }else{
      drawing={kind:currentTool,last:p};paintStroke(p,p,currentTool==='erase');
    }
    updateSelectionUI();drawProcessed(ctx,canvas,true);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drawing)return;const p=canvasPoint(e);invalidateFillPlan();
    if(drawing.kind==='rect')drawing.current=p;
    else{
      // Use every buffered pointer sample so fast strokes stay smooth instead of cutting corners.
      const samples=(e.getCoalescedEvents&&e.getCoalescedEvents())||[];
      for(const ev of (samples.length?samples:[e])){const q=canvasPoint(ev);paintStroke(drawing.last,q,drawing.kind==='erase');drawing.last=q;}
    }
    updateSelectionUI();drawProcessed(ctx,canvas,true);
  });
  canvas.addEventListener('pointerenter',e=>{lastPointer=e;updateBrushCursor(e);});
  canvas.addEventListener('pointermove',e=>{lastPointer=e;updateBrushCursor(e);});
  canvas.addEventListener('pointerleave',()=>{lastPointer=null;updateBrushCursor(null);});
  document.addEventListener('keydown',e=>{
    if(e.ctrlKey||e.metaKey||e.altKey||exporting)return;
    const t=e.target;if(t&&(t.isContentEditable||t.tagName==='TEXTAREA'||(t.tagName==='INPUT'&&t.type==='text')))return;
    const k=e.key.toLowerCase();
    if(k==='r')setTool('rectangle');else if(k==='b')setTool('brush');else if(k==='e')setTool('erase');
    else if(e.key==='['||e.key===']'){
      const s=$('brushSize'),v=Number(s.value),step=Math.max(2,Math.round(v*.12));
      s.value=String(clamp(v+(e.key===']'?step:-step),Number(s.min),Number(s.max)));
      s.dispatchEvent(new Event('input'));e.preventDefault();
    }
  });
  const stopDrawing=()=>{
    if(!drawing)return;
    if(drawing.kind==='rect'){
      const p=drawing.start,q=drawing.current,x=Math.floor(Math.min(p.x,q.x)),y=Math.floor(Math.min(p.y,q.y)),w=Math.ceil(Math.abs(q.x-p.x)),h=Math.ceil(Math.abs(q.y-p.y));
      if(w>=3&&h>=3){maskCtx.save();maskCtx.globalCompositeOperation='source-over';maskCtx.fillStyle='#8ce6d0';maskCtx.fillRect(x,y,w,h);maskCtx.restore();selectionBounds={x,y,w,h};}else selectionBounds=null;
    }else recomputeBounds();
    drawing=null;invalidateFillPlan();updateSelectionUI();if(hasMedia())drawProcessed(ctx,canvas,true);
  };
  canvas.addEventListener('pointerup',stopDrawing);canvas.addEventListener('pointercancel',stopDrawing);canvas.addEventListener('lostpointercapture',stopDrawing);

  $('chooseFileBtn').addEventListener('click',()=>fileInput.click());$('changeFileBtn').addEventListener('click',()=>fileInput.click());
  fileInput.addEventListener('change',e=>{useFile(e.target.files&&e.target.files[0]);fileInput.value='';});
  dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.style.borderColor='#8ce6d0';});dropZone.addEventListener('dragleave',()=>{dropZone.style.borderColor='';});
  dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.style.borderColor='';const f=e.dataTransfer.files&&e.dataTransfer.files[0];if(f)useFile(f);});
  document.querySelectorAll('[data-tool]').forEach(btn=>btn.addEventListener('click',()=>setTool(btn.dataset.tool)));
  $('playBtn').addEventListener('click',async()=>{if(!hasVideo())return;if(video.paused){try{await video.play();}catch(e){setStatus('The browser could not play this file. Try a browser-supported video format.','error');}}else video.pause();updateTransport();});
  video.addEventListener('loadedmetadata',()=>{if(mediaKind==='video')onMediaReady();});
  video.addEventListener('loadeddata',()=>{if(hasVideo())drawProcessed(ctx,canvas,true);});
  video.addEventListener('error',()=>{if(mediaKind==='video')setStatus('This video could not be opened by your browser. Try a standard H.264 MP4 or WebM file.','error');});
  video.addEventListener('play',updateTransport);video.addEventListener('pause',updateTransport);video.addEventListener('timeupdate',updateTransport);video.addEventListener('seeked',()=>{if(hasVideo())drawProcessed(ctx,canvas,true);updateTransport();});
  function seekFromControl(value){if(hasVideo()&&Number.isFinite(video.duration))video.currentTime=(Number(value)/1000)*video.duration;}
  $('seekBarWide').addEventListener('input',e=>seekFromControl(e.target.value));
  $('clearSelectionBtn').addEventListener('click',clearMask);
  document.querySelectorAll('input[name="effect"]').forEach(el=>el.addEventListener('change',()=>{showEffectControls();if(hasMedia())drawProcessed(ctx,canvas,true);}));
  $('brushSize').addEventListener('input',()=>{$('brushValue').textContent=$('brushSize').value+' px';previewBrushSize();});
  $('blurAmount').addEventListener('input',()=>{$('blurValue').textContent=$('blurAmount').value+' px';if(hasMedia())drawProcessed(ctx,canvas,true);});
  $('featherAmount').addEventListener('input',()=>{$('featherValue').textContent=$('featherAmount').value+' px';if(hasMedia())drawProcessed(ctx,canvas,true);});
  $('fillPasses').addEventListener('input',()=>{$('fillPassesValue').textContent=$('fillPasses').value+' passes';if(hasMedia())drawProcessed(ctx,canvas,true);});
  function setProgress(n,txt){const p=clamp(Math.round(n),0,100);$('progressBar').style.width=p+'%';$('progressPct').textContent=p+'%';if(txt)$('progressText').textContent=txt;}
  function setSettingsLocked(locked){['brushSize','blurAmount','featherAmount','fillPasses'].forEach(id=>{$(id).disabled=locked;});document.querySelectorAll('input[name="effect"]').forEach(el=>{el.disabled=locked;});$('clearSelectionBtn').disabled=locked||!hasSelection();}
  function stopExportUI(){exporting=false;setSettingsLocked(false);$('progressWrap').style.display='none';$('exportBtn').disabled=!hasMedia()||!hasSelection();$('changeFileBtn').disabled=false;$('playBtn').disabled=!hasVideo();$('seekBarWide').disabled=!hasVideo();canvas.style.cursor=cursorFor(currentTool);}
  function supportedMime(){if(!window.MediaRecorder)return'';const types=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];return types.find(t=>MediaRecorder.isTypeSupported(t))||'';}

  // MediaRecorder WebM files can lack the Duration field that gallery apps use
  // to report clip length. Add or update that EBML metadata without re-encoding.
  async function fixWebmDuration(blob,durationMs){
    if(!blob||!Number.isFinite(durationMs)||durationMs<=0)return blob;
    try{
      const buffer=typeof blob.arrayBuffer==='function'
        ? await blob.arrayBuffer()
        : await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(blob);});
      const bytes=new Uint8Array(buffer);
      const readVint=(pos,isSize)=>{
        if(pos<0||pos>=bytes.length)return null;
        const first=bytes[pos];let length=1,marker=0x80;
        while(length<=8&&(first&marker)===0){marker>>=1;length++;}
        if(length>8||pos+length>bytes.length)return null;
        let value=isSize?(first&(marker-1)):first;
        for(let i=1;i<length;i++)value=value*256+bytes[pos+i];
        return {value,length,unknown:isSize&&value===Math.pow(2,7*length)-1};
      };
      const elementAt=(pos,parentEnd)=>{
        const id=readVint(pos,false);if(!id)return null;
        const size=readVint(pos+id.length,true);if(!size)return null;
        const dataStart=pos+id.length+size.length;
        const end=size.unknown?parentEnd:dataStart+size.value;
        if(end<dataStart||end>parentEnd)return null;
        return {id:id.value,start:pos,sizeStart:pos+id.length,size,dataStart,end,unknown:size.unknown};
      };
      const concat=parts=>{
        const total=parts.reduce((sum,part)=>sum+part.length,0),out=new Uint8Array(total);let offset=0;
        for(const part of parts){out.set(part,offset);offset+=part.length;}
        return out;
      };
      const encodeSize=(value,minLength)=>{
        for(let length=Math.max(1,minLength||1);length<=8;length++){
          if(value>Math.pow(2,7*length)-2)continue;
          const out=new Uint8Array(length);let remaining=value;
          for(let i=length-1;i>=0;i--){out[i]=remaining%256;remaining=Math.floor(remaining/256);}
          out[0]|=1<<(8-length);return out;
        }
        return null;
      };
      let segment=null,cursor=0;
      while(cursor<bytes.length){
        const element=elementAt(cursor,bytes.length);if(!element)break;
        if(element.id===0x18538067){segment=element;break;}
        if(element.unknown||element.end<=cursor)break;
        cursor=element.end;
      }
      if(!segment)return blob;
      let info=null;cursor=segment.dataStart;
      while(cursor<segment.end){
        const element=elementAt(cursor,segment.end);if(!element)break;
        if(element.id===0x1549A966){info=element;break;}
        if(element.unknown||element.end<=cursor)break;
        cursor=element.end;
      }
      if(!info)return blob;
      let timecodeScale=1000000,durationElement=null;cursor=info.dataStart;
      while(cursor<info.end){
        const element=elementAt(cursor,info.end);if(!element)break;
        if(element.id===0x2AD7B1&&element.end>element.dataStart){
          let scale=0;for(let i=element.dataStart;i<element.end;i++)scale=scale*256+bytes[i];
          if(Number.isFinite(scale)&&scale>0)timecodeScale=scale;
        }else if(element.id===0x4489){durationElement=element;}
        if(element.unknown||element.end<=cursor)break;
        cursor=element.end;
      }
      const durationValue=durationMs*1000000/timecodeScale;
      if(!Number.isFinite(durationValue)||durationValue<=0)return blob;
      if(durationElement){
        const patched=bytes.slice(),size=durationElement.end-durationElement.dataStart;
        const view=new DataView(patched.buffer,patched.byteOffset+durationElement.dataStart,size);
        if(size===4)view.setFloat32(0,durationValue,false);
        else if(size===8)view.setFloat64(0,durationValue,false);
        else return blob;
        return new Blob([patched],{type:blob.type||'video/webm'});
      }
      // An EBML float64 is encoded as ID 0x4489, size 8, then eight data bytes.
      const durationElementBytes=new Uint8Array(11);durationElementBytes[0]=0x44;durationElementBytes[1]=0x89;durationElementBytes[2]=0x88;
      new DataView(durationElementBytes.buffer).setFloat64(3,durationValue,false);
      const infoPayload=concat([bytes.slice(info.dataStart,info.end),durationElementBytes]);
      const encodedInfoSize=encodeSize(infoPayload.length,info.size.length);if(!encodedInfoSize)return blob;
      const infoBytes=concat([bytes.slice(info.start,info.sizeStart),encodedInfoSize,infoPayload]);
      const delta=infoBytes.length-(info.end-info.start);
      if(segment.unknown){
        return new Blob([bytes.slice(0,info.start),infoBytes,bytes.slice(info.end)],{type:blob.type||'video/webm'});
      }
      const encodedSegmentSize=encodeSize(segment.size.value+delta,segment.size.length);if(!encodedSegmentSize)return blob;
      const segmentHeader=concat([bytes.slice(segment.start,segment.sizeStart),encodedSegmentSize]);
      const repaired=concat([
        bytes.slice(0,segment.start),segmentHeader,bytes.slice(segment.dataStart,info.start),
        infoBytes,bytes.slice(info.end,segment.end),bytes.slice(segment.end)
      ]);
      return new Blob([repaired],{type:blob.type||'video/webm'});
    }catch(err){
      // A metadata repair must never discard an otherwise usable recording.
      return blob;
    }
  }

  $('exportBtn').addEventListener('click',async()=>{
    if(!hasMedia()||!hasSelection()||exporting)return;
    if(hasImage()){
      exporting=true;$('exportBtn').disabled=true;$('changeFileBtn').disabled=true;$('progressWrap').style.display='grid';$('cancelExportBtn').style.display='none';setProgress(30,'Rendering PNG…');
      try{
        const outCanvas=document.createElement('canvas');outCanvas.width=image.naturalWidth;outCanvas.height=image.naturalHeight;const outCtx=outCanvas.getContext('2d');drawProcessed(outCtx,outCanvas,false);
        const blob=await new Promise((resolve,reject)=>outCanvas.toBlob(b=>b?resolve(b):reject(new Error('PNG encoding failed')),'image/png'));
        const out=URL.createObjectURL(blob),a=document.createElement('a'),base=(currentFile?.name||'image').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]+/g,'_');a.href=out;a.download=base+'-cleaned.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(out),60000);
        setProgress(100,'Finished');setStatus(`Export complete. Saved ${a.download}.`,'success');
      }catch(err){setStatus('Could not export the image. Try a smaller image or a recent browser.','error');}
      finally{exporting=false;$('progressWrap').style.display='none';$('changeFileBtn').disabled=false;updateSelectionUI();}
      return;
    }
    if(!hasVideo())return;
    const mime=supportedMime();if(!mime){setStatus('This browser does not support video recording here. Try recent Chrome, Edge, or Firefox.','error');return;}
    if(typeof document.createElement('canvas').captureStream!=='function'){setStatus('Canvas video capture is not supported here. Try recent Chrome, Edge, or Firefox.','error');return;}
    exporting=true;recordedChunks=[];exportDuration=Number.isFinite(video.duration)?video.duration:0;
    $('progressWrap').style.display='grid';setProgress(0,'Preparing video…');$('exportBtn').disabled=true;$('changeFileBtn').disabled=true;$('playBtn').disabled=true;$('seekBarWide').disabled=true;canvas.style.cursor='wait';updateBrushCursor(null);setSettingsLocked(true);$('cancelExportBtn').style.display='';
    try{
      exportCanvas=document.createElement('canvas');exportCanvas.width=video.videoWidth;exportCanvas.height=video.videoHeight;exportCtx=exportCanvas.getContext('2d');drawProcessed(exportCtx,exportCanvas,false);
      // Capture frames on demand where supported. A fixed 30 fps stream can
      // duplicate stale frames if the inpainting step takes longer than 33 ms.
      let vStream=exportCanvas.captureStream(0);
      exportVideoTrack=vStream.getVideoTracks()[0]||null;
      if(!exportVideoTrack||typeof exportVideoTrack.requestFrame!=='function'){
        vStream.getTracks().forEach(t=>{try{t.stop();}catch(e){}});
        vStream=exportCanvas.captureStream(30);
        exportVideoTrack=vStream.getVideoTracks()[0]||null;
      }
      let audioTracks=[];
      try{const capture=typeof video.captureStream==='function'?video.captureStream():(typeof video.mozCaptureStream==='function'?video.mozCaptureStream():null);if(capture)audioTracks=capture.getAudioTracks();}catch(err){audioTracks=[];}
      exportAudioAvailable=audioTracks.length>0;exportStream=new MediaStream([...vStream.getVideoTracks(),...audioTracks]);
      recorder=new MediaRecorder(exportStream,{mimeType:mime,videoBitsPerSecond:Math.min(12000000,Math.max(2500000,video.videoWidth*video.videoHeight*4))});
      recorder.ondataavailable=e=>{if(e.data&&e.data.size)recordedChunks.push(e.data);};
      recorder.onerror=()=>{setStatus('The browser encountered an error while recording. Try a shorter or smaller video.','error');try{recorder.stop();}catch(e){finishExportCleanup();}};
      recorder.onstop=async()=>{
        try{
          if(!recordedChunks.length){setStatus('No video data was recorded. Try another browser or video format.','error');return;}
          const rawBlob=new Blob(recordedChunks,{type:mime});
          const blob=await fixWebmDuration(rawBlob,recordedDurationMs||exportDuration*1000);
          const out=URL.createObjectURL(blob),a=document.createElement('a'),base=(currentFile?.name||'video').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]+/g,'_');
          a.href=out;a.download=base+'-cleaned.webm';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(out),60000);
          setStatus(`Export complete. Saved ${a.download}.${exportAudioAvailable?' Audio was included when available.':' The browser did not expose an audio track, so this export may be silent.'}`,'success');
        }catch(err){setStatus('The video was recorded but could not be downloaded automatically. Check your browser downloads.','error');}
        finally{finishExportCleanup();}
      };
      video.pause();
      if(video.currentTime>0.01){await new Promise(resolve=>{const done=()=>resolve();video.addEventListener('seeked',done,{once:true});video.currentTime=0;});}
      else video.currentTime=0;
      if(video.readyState<2)await new Promise((resolve,reject)=>{const ready=()=>{clean();resolve();},fail=()=>{clean();reject(new Error('Video was not ready'));},clean=()=>{video.removeEventListener('canplay',ready);video.removeEventListener('error',fail);};video.addEventListener('canplay',ready,{once:true});video.addEventListener('error',fail,{once:true});});
      drawProcessed(exportCtx,exportCanvas,false);
      // Track the active recording time for WebM duration metadata.
      recordingStartedAt=performance.now();recordedDurationMs=0;
      // Avoid small MediaRecorder timeslices and let the browser finalize one recording.
      recorder.start();setProgress(1,'Recording processed video…');
      const progressTimer=setInterval(()=>{if(!exporting){clearInterval(progressTimer);return;}const pct=exportDuration>0?Math.min(99,(video.currentTime/exportDuration)*100):0;setProgress(pct,`Recording… ${fmtTime(video.currentTime)} / ${fmtTime(exportDuration)}`);},250);
      const rec=recorder;let hiddenPause=false;
      // Draw one last frame and give the recorder a moment to receive it before stopping.
      const ended=()=>{
        clearInterval(progressTimer);
        if(recordingStartedAt){recordedDurationMs+=performance.now()-recordingStartedAt;recordingStartedAt=0;}
        if(exportCtx&&exportCanvas){
          drawProcessed(exportCtx,exportCanvas,false);
          if(exportVideoTrack&&typeof exportVideoTrack.requestFrame==='function'){
            try{exportVideoTrack.requestFrame();}catch(e){}
          }
        }
        // Allow the final captured frame to reach the encoder before finalizing.
        setTimeout(()=>{if(rec.state!=='inactive')rec.stop();},250);
      };
      // If playback is interrupted (media key, OS, etc.) resume it rather than hanging forever.
      const onPause=()=>{if(!exporting||hiddenPause||video.ended)return;if(Number.isFinite(video.duration)&&video.currentTime>=video.duration-0.15)return;video.play().catch(()=>abortExport('Playback was interrupted, so the export was stopped. Nothing was saved.'));};
      const onVideoError=()=>abortExport('The video failed during export, so the export was stopped. Nothing was saved.');
      // Browsers stop animation frames in a hidden tab, which would record frozen frames. Pause until it is visible again.
      const onVisibility=()=>{
        if(!exporting)return;
        if(document.hidden){
          hiddenPause=true;video.pause();
          if(rec.state==='recording'){
            if(recordingStartedAt){recordedDurationMs+=performance.now()-recordingStartedAt;recordingStartedAt=0;}
            rec.pause();
          }
          setStatus('Export paused while this tab is hidden. Return to this tab to continue.');
        }else if(hiddenPause){
          hiddenPause=false;
          if(rec.state==='paused'){recordingStartedAt=performance.now();rec.resume();}
          setStatus('Recording processed video…');
          video.play().catch(()=>abortExport('Playback could not resume, so the export was stopped. Nothing was saved.'));
        }
      };
      video.addEventListener('ended',ended,{once:true});video.addEventListener('pause',onPause);video.addEventListener('error',onVideoError);document.addEventListener('visibilitychange',onVisibility);
      window.__localWatermarkExportCleanup=()=>{clearInterval(progressTimer);video.removeEventListener('ended',ended);video.removeEventListener('pause',onPause);video.removeEventListener('error',onVideoError);document.removeEventListener('visibilitychange',onVisibility);};
      await video.play();
    }catch(err){finishExportCleanup();setStatus('Could not export this video. Try a recent Chrome, Edge, or Firefox browser and a smaller file.','error');}
  });
  function abortExport(message,type='error'){finishExportCleanup();setStatus(message,type);}
  $('cancelExportBtn').addEventListener('click',()=>{if(exporting&&mediaKind==='video')abortExport('Export canceled. Nothing was saved.','');});
  function finishExportCleanup(){if(window.__localWatermarkExportCleanup){try{window.__localWatermarkExportCleanup();}catch(e){}window.__localWatermarkExportCleanup=null;}
    // Detach the recorder first so a late stop event cannot overwrite the status or trigger a download.
    if(recorder){const r=recorder;r.ondataavailable=null;r.onerror=null;if(r.state!=='inactive'){r.onstop=null;try{r.stop();}catch(e){}}}
    try{if(!video.paused&&!video.ended)video.pause();}catch(e){}
    if(exportStream){exportStream.getTracks().forEach(t=>{try{t.stop();}catch(e){}});exportStream=null;}exportVideoTrack=null;recordingStartedAt=0;recordedDurationMs=0;recorder=null;exportCanvas=null;exportCtx=null;recordedChunks=[];stopExportUI();updateTransport();if(hasMedia())drawProcessed(ctx,canvas,true);setProgress(100,'Finished');}
  window.addEventListener('watermark-wasm-ready',()=>{setFillStatus('Bundled WebAssembly fill is ready. Your media stays on this device.');if(hasMedia()&&activeEffect()==='remove')drawProcessed(ctx,canvas,true);});
  if(window.LocalWatermarkWasm&&window.LocalWatermarkWasm.isReady())setFillStatus('Bundled WebAssembly fill is ready. Your media stays on this device.');
  $('fillPassesValue').textContent=$('fillPasses').value+' passes';showEffectControls();setTool('rectangle');updateSelectionUI();rafId=requestAnimationFrame(renderLoop);
  window.addEventListener('beforeunload',()=>{if(currentUrl)URL.revokeObjectURL(currentUrl);if(exportStream)exportStream.getTracks().forEach(t=>t.stop());if(rafId)cancelAnimationFrame(rafId);});
})();

"use strict";

const params = new URLSearchParams(location.search);
const mode = params.get("mode");

const homeView = document.querySelector("#homeView");
const screenView = document.querySelector("#screenView");
const mobileView = document.querySelector("#mobileView");

document.querySelector("#openScreenBtn").addEventListener("click", () => {
  location.href = `${location.pathname}?mode=screen`;
});

document.querySelector("#openMobileTestBtn").addEventListener("click", () => {
  location.href = `${location.pathname}?mode=mobile`;
});

if (mode === "screen") startScreenMode();
else if (mode === "mobile") startMobileMode();

/* -------------------- 共用工具 -------------------- */

function createSegmenter(onResults) {
  const segmenter = new SelfieSegmentation({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
  });

  segmenter.setOptions({
    modelSelection: 1,
    // 統一由我們自己處理鏡像，避免手機與電腦方向不一致。
    selfieMode: false
  });

  segmenter.onResults(onResults);
  return segmenter;
}

function fitCover(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;

  return {
    x: (dstW - w) / 2,
    y: (dstH - h) / 2,
    w,
    h
  };
}

function fitContain(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;

  return {
    x: (dstW - w) / 2,
    y: (dstH - h) / 2,
    w,
    h
  };
}

function createPeer(id) {
  return new Peer(id, {
    debug: 1,
    config: {
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302"
        },
        {
          urls: "stun:stun1.l.google.com:19302"
        }
      ]
    }
  });
}

async function optimizeOutgoingVideo(call, stream) {
  const track = stream.getVideoTracks()[0];

  if (!track || !call?.peerConnection) {
    return;
  }

  if ("contentHint" in track) {
    track.contentHint = "motion";
  }

  const sender = call.peerConnection
    .getSenders()
    .find((item) => item.track?.kind === "video");

  if (!sender) {
    return;
  }

  try {
    const parameters = sender.getParameters();

    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }

    parameters.encodings[0].maxBitrate = 5_000_000;
    parameters.encodings[0].maxFramerate = 24;
    parameters.encodings[0].scaleResolutionDownBy = 1;
    parameters.degradationPreference = "maintain-resolution";

    await sender.setParameters(parameters);
  } catch (error) {
    console.warn("瀏覽器未接受全部影像參數：", error);
  }
}

function drawSource(ctx, source, width, height, mirrored) {
  ctx.save();

  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
}

/* -------------------- WebGL 綠幕去除 -------------------- */

function createChromaRenderer(canvas, video) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true
  });

  if (!gl) {
    throw new Error("此電腦瀏覽器不支援 WebGL");
  }

  const vertexSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }
  `;

  const fragmentSource = `
    precision mediump float;

    uniform sampler2D u_image;
    varying vec2 v_texCoord;

    void main() {
      vec4 color = texture2D(u_image, v_texCoord);

      float other = max(color.r, color.b);
      float greenExcess = color.g - other;

      float keyed = smoothstep(0.10, 0.32, greenExcess);
      float alpha = 1.0 - keyed;

      float despill = keyed * 0.82;
      color.g = mix(color.g, other, despill);

      if (alpha < 0.025) {
        discard;
      }

      gl_FragColor = vec4(color.rgb * alpha, alpha);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }

    return shader;
  }

  const program = gl.createProgram();

  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, vertexSource)
  );

  gl.attachShader(
    program,
    compile(gl.FRAGMENT_SHADER, fragmentSource)
  );

  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }

  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const positionBuffer = gl.createBuffer();
  const texCoordBuffer = gl.createBuffer();

  const positionLoc = gl.getAttribLocation(
    program,
    "a_position"
  );

  const texCoordLoc = gl.getAttribLocation(
    program,
    "a_texCoord"
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);

  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      0, 1,
      1, 1,
      0, 0,

      0, 0,
      1, 1,
      1, 0
    ]),
    gl.STATIC_DRAW
  );

  gl.enableVertexAttribArray(texCoordLoc);

  gl.vertexAttribPointer(
    texCoordLoc,
    2,
    gl.FLOAT,
    false,
    0,
    0
  );

  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_S,
    gl.CLAMP_TO_EDGE
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_T,
    gl.CLAMP_TO_EDGE
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MAG_FILTER,
    gl.LINEAR
  );

  function resize() {
    const ratio = Math.max(
      1,
      Math.min(window.devicePixelRatio || 1, 1.5)
    );

    const width = Math.round(
      window.innerWidth * ratio
    );

    const height = Math.round(
      window.innerHeight * ratio
    );

    if (
      canvas.width !== width ||
      canvas.height !== height
    ) {
      canvas.width = width;
      canvas.height = height;

      gl.viewport(
        0,
        0,
        width,
        height
      );
    }
  }

  function updateGeometry() {
    const srcW = video.videoWidth || 1280;
    const srcH = video.videoHeight || 720;

    const dstW = canvas.width;
    const dstH = canvas.height;

    const rect = fitContain(
      srcW,
      srcH,
      dstW,
      dstH
    );

    const left =
      (rect.x / dstW) * 2 - 1;

    const right =
      ((rect.x + rect.w) / dstW) * 2 - 1;

    const top =
      1 - (rect.y / dstH) * 2;

    const bottom =
      1 - ((rect.y + rect.h) / dstH) * 2;

    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      positionBuffer
    );

    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        left, bottom,
        right, bottom,
        left, top,

        left, top,
        right, bottom,
        right, top
      ]),
      gl.DYNAMIC_DRAW
    );

    gl.enableVertexAttribArray(
      positionLoc
    );

    gl.vertexAttribPointer(
      positionLoc,
      2,
      gl.FLOAT,
      false,
      0,
      0
    );
  }

  function render() {
    resize();

    gl.clearColor(
      0,
      0,
      0,
      0
    );

    gl.clear(
      gl.COLOR_BUFFER_BIT
    );

    if (video.readyState >= 2) {
      updateGeometry();

      gl.bindTexture(
        gl.TEXTURE_2D,
        texture
      );

      gl.pixelStorei(
        gl.UNPACK_FLIP_Y_WEBGL,
        true
      );

      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video
      );

      gl.drawArrays(
        gl.TRIANGLES,
        0,
        6
      );
    }

    requestAnimationFrame(render);
  }

  return {
    render
  };
}

/* -------------------- 大螢幕模式 -------------------- */

async function startScreenMode() {
  homeView.classList.add("hidden");
  screenView.classList.remove("hidden");

  const backgroundCanvas =
    document.querySelector("#screenCanvas");

  const bgCtx =
    backgroundCanvas.getContext(
      "2d",
      {
        alpha: false
      }
    );

  const personCanvas =
    document.querySelector("#personCanvas");

  const remoteVideo =
    document.querySelector("#remoteVideo");

  const panel =
    document.querySelector("#screenPanel");

  const mobileUrlBox =
    document.querySelector("#mobileUrl");

  const screenStatus =
    document.querySelector("#screenStatus");

  const fullscreenBtn =
    document.querySelector("#fullscreenBtn");

  fullscreenBtn.addEventListener(
    "click",
    async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();

          fullscreenBtn.textContent =
            "已進入全螢幕";
        }
      } catch (error) {
        console.error(
          "全螢幕失敗：",
          error
        );

        fullscreenBtn.textContent =
          "請按 F11 進入全螢幕";
      }
    }
  );

  const bg = new Image();

  bg.src = "background.jpg";

  try {
    await bg.decode();
  } catch (error) {
    console.error(
      "背景圖片載入失敗：",
      error
    );

    screenStatus.textContent =
      `背景圖片載入失敗：${error.message || error}`;
  }

  function resizeBackground() {
    const ratio = Math.max(
      1,
      Math.min(window.devicePixelRatio || 1, 1.5)
    );

    backgroundCanvas.width = Math.round(
      window.innerWidth * ratio
    );

    backgroundCanvas.height = Math.round(
      window.innerHeight * ratio
    );

    drawBackground();
  }

  function drawBackground() {
    const width =
      backgroundCanvas.width;

    const height =
      backgroundCanvas.height;

    bgCtx.clearRect(
      0,
      0,
      width,
      height
    );

    if (!bg.naturalWidth || !bg.naturalHeight) {
      bgCtx.fillStyle = "#111";

      bgCtx.fillRect(
        0,
        0,
        width,
        height
      );

      return;
    }

    const cover = fitCover(
      bg.naturalWidth,
      bg.naturalHeight,
      width,
      height
    );

    bgCtx.save();

    bgCtx.filter =
      "blur(28px) brightness(.44) saturate(.52)";

    bgCtx.drawImage(
      bg,
      cover.x - 24,
      cover.y - 24,
      cover.w + 48,
      cover.h + 48
    );

    bgCtx.restore();

    const contain = fitContain(
      bg.naturalWidth,
      bg.naturalHeight,
      width,
      height
    );

    bgCtx.save();

    bgCtx.shadowColor =
      "rgba(0,0,0,.68)";

    bgCtx.shadowBlur = 42;

    bgCtx.drawImage(
      bg,
      contain.x,
      contain.y,
      contain.w,
      contain.h
    );

    bgCtx.restore();
  }

  window.addEventListener(
    "resize",
    resizeBackground
  );

  resizeBackground();

  try {
    const chroma = createChromaRenderer(
      personCanvas,
      remoteVideo
    );

    chroma.render();
  } catch (error) {
    console.error(
      "綠幕去除啟動失敗：",
      error
    );

    screenStatus.textContent =
      `綠幕去除失敗：${error.message || error}`;
  }

  const roomId =
    `timeportal-${crypto.randomUUID().slice(0, 8)}`;

  const peer =
    createPeer(roomId);

  peer.on(
    "open",
    () => {
      const mobileUrl =
        new URL(location.href);

      mobileUrl.search = "";

      mobileUrl.searchParams.set(
        "mode",
        "mobile"
      );

      mobileUrl.searchParams.set(
        "room",
        roomId
      );

      mobileUrlBox.textContent =
        mobileUrl.toString();

      const qrcodeBox =
        document.querySelector("#qrcode");

      qrcodeBox.innerHTML = "";

      new QRCode(
        qrcodeBox,
        {
          text: mobileUrl.toString(),
          width: 180,
          height: 180
        }
      );

      screenStatus.textContent =
        "房間已建立，等待手機掃描";
    }
  );

  peer.on(
    "call",
    (call) => {
      screenStatus.textContent =
        "手機已找到，正在建立人物影像…";

      call.answer();

      call.on(
        "stream",
        async (stream) => {
          remoteVideo.srcObject =
            stream;

          try {
            await remoteVideo.play();
          } catch (error) {
            console.error(
              "遠端影像播放失敗：",
              error
            );

            screenStatus.textContent =
              `遠端影像播放失敗：${error.message || error}`;

            return;
          }

          panel.classList.add(
            "hidden"
          );
        }
      );

      call.on(
        "close",
        () => {
          remoteVideo.srcObject =
            null;

          panel.classList.remove(
            "hidden"
          );

          screenStatus.textContent =
            "手機已中斷，等待重新連線";
        }
      );

      call.on(
        "error",
        (error) => {
          console.error(
            "影像連線錯誤：",
            error
          );

          screenStatus.textContent =
            `影像連線錯誤：${error.message || error}`;
        }
      );
    }
  );

  peer.on(
    "error",
    (error) => {
      console.error(
        "PeerJS 配對錯誤：",
        error
      );

      screenStatus.textContent =
        `配對錯誤：${error.type || error.message || error}`;
    }
  );
}

/* -------------------- 手機模式 -------------------- */

function startMobileMode() {
  homeView.classList.add("hidden");
  mobileView.classList.remove("hidden");

  const video =
    document.querySelector("#cameraVideo");

  const previewCanvas =
    document.querySelector("#mobileCanvas");

  const previewCtx =
    previewCanvas.getContext("2d");

  const startPanel =
    document.querySelector("#mobileStart");

  const startBtn =
    document.querySelector("#startCameraBtn");

  const switchBtn =
    document.querySelector("#switchCameraBtn");

  const status =
    document.querySelector("#mobileStatus");

  const sendCanvas =
    document.createElement("canvas");

  const sendCtx =
    sendCanvas.getContext("2d");

  const rawMaskCanvas =
    document.createElement("canvas");

  const rawMaskCtx =
    rawMaskCanvas.getContext("2d");

  const smoothMaskCanvas =
    document.createElement("canvas");

  const smoothMaskCtx =
    smoothMaskCanvas.getContext("2d");

  const previousMaskCanvas =
    document.createElement("canvas");

  const previousMaskCtx =
    previousMaskCanvas.getContext("2d");

  const personCanvas =
    document.createElement("canvas");

  const personCtx =
    personCanvas.getContext("2d");

  const outlineCanvas =
    document.createElement("canvas");

  const outlineCtx =
    outlineCanvas.getContext("2d");

  let stream = null;
  let facingMode = "user";
  let segmenter = null;

  let processing = false;
  let segmentBusy = false;
  let lastSegmentAt = 0;
  let hasMask = false;

  let peer = null;
  let call = null;

  function isLineBrowser() {
    return /Line\//i.test(
      navigator.userAgent
    );
  }

  function setStatus(text) {
    status.style.whiteSpace =
      "normal";

    status.style.maxWidth =
      "";

    status.textContent =
      text;
  }

  function getCameraErrorText(
    title,
    error
  ) {
    const errorName =
      error?.name ||
      "UnknownError";

    const errorMessage =
      error?.message ||
      String(error || "未知錯誤");

    const mediaDevicesSupported =
      Boolean(
        navigator.mediaDevices
      );

    const getUserMediaSupported =
      Boolean(
        navigator.mediaDevices?.getUserMedia
      );

    return [
      title,
      `error.name：${errorName}`,
      `error.message：${errorMessage}`,
      `安全環境：${window.isSecureContext ? "是" : "否"}`,
      `mediaDevices：${mediaDevicesSupported ? "支援" : "不支援"}`,
      `getUserMedia：${getUserMediaSupported ? "支援" : "不支援"}`,
      `LINE 內建瀏覽器：${isLineBrowser() ? "是" : "否"}`
    ].join("\n");
  }

  function showCameraError(
    title,
    error
  ) {
    const text =
      getCameraErrorText(
        title,
        error
      );

    console.error(
      title,
      error
    );

    console.error(
      "error.name:",
      error?.name
    );

    console.error(
      "error.message:",
      error?.message
    );

    console.error(
      "camera diagnostics:\n" + text
    );

    status.style.whiteSpace =
      "pre-wrap";

    status.style.maxWidth =
      "75vw";

    status.style.overflowWrap =
      "anywhere";

    status.style.borderRadius =
      "16px";

    status.textContent =
      text;
  }

  function resizeCanvases() {
    const width =
      video.videoWidth || 1280;

    const height =
      video.videoHeight || 720;

    const allCanvases = [
      previewCanvas,
      sendCanvas,
      rawMaskCanvas,
      smoothMaskCanvas,
      previousMaskCanvas,
      personCanvas,
      outlineCanvas
    ];

    if (
      previewCanvas.width === width &&
      previewCanvas.height === height
    ) {
      return;
    }

    allCanvases.forEach(
      (canvas) => {
        canvas.width =
          width;

        canvas.height =
          height;
      }
    );

    previousMaskCtx.clearRect(
      0,
      0,
      width,
      height
    );

    hasMask = false;
  }

  async function openCamera() {
    if (stream) {
      stream
        .getTracks()
        .forEach(
          (track) => track.stop()
        );

      stream = null;
    }

    setStatus(
      "正在開啟相機…"
    );

    if (!window.isSecureContext) {
      const error =
        new Error(
          "相機只能在 HTTPS 或 localhost 安全環境中使用"
        );

      error.name =
        "SecurityError";

      throw error;
    }

    if (!navigator.mediaDevices) {
      const error =
        new Error(
          "此瀏覽器沒有 navigator.mediaDevices"
        );

      error.name =
        "NotSupportedError";

      throw error;
    }

    if (
      typeof navigator.mediaDevices.getUserMedia !==
      "function"
    ) {
      const error =
        new Error(
          "此瀏覽器不支援 navigator.mediaDevices.getUserMedia()"
        );

      error.name =
        "NotSupportedError";

      throw error;
    }

    stream =
      await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: {
            ideal: facingMode
          },
          width: {
            ideal: 1280
          },
          height: {
            ideal: 720
          },
          frameRate: {
            ideal: 30,
            min: 20
          }
        },
        audio: false
      });

    video.srcObject =
      stream;

    await video.play();

    resizeCanvases();

    const track =
      stream.getVideoTracks()[0];

    const settings =
      track?.getSettings?.() || {};

    setStatus(
      `${settings.width || "?"}×` +
      `${settings.height || "?"}・` +
      `${Math.round(settings.frameRate || 0)}fps`
    );
  }

  function updateMask(results) {
    const width =
      previewCanvas.width;

    const height =
      previewCanvas.height;

    const mirrored =
      facingMode === "user";

    rawMaskCtx.clearRect(
      0,
      0,
      width,
      height
    );

    rawMaskCtx.save();

    rawMaskCtx.filter =
      "blur(0.8px) contrast(180%)";

    drawSource(
      rawMaskCtx,
      results.segmentationMask,
      width,
      height,
      mirrored
    );

    rawMaskCtx.restore();

    smoothMaskCtx.clearRect(
      0,
      0,
      width,
      height
    );

    if (hasMask) {
      smoothMaskCtx.save();

      smoothMaskCtx.globalAlpha =
        0.58;

      smoothMaskCtx.drawImage(
        previousMaskCanvas,
        0,
        0
      );

      smoothMaskCtx.restore();
    }

    smoothMaskCtx.save();

    smoothMaskCtx.globalAlpha =
      hasMask ? 0.42 : 1;

    smoothMaskCtx.drawImage(
      rawMaskCanvas,
      0,
      0
    );

    smoothMaskCtx.restore();

    previousMaskCtx.clearRect(
      0,
      0,
      width,
      height
    );

    previousMaskCtx.drawImage(
      smoothMaskCanvas,
      0,
      0
    );

    hasMask = true;
    segmentBusy = false;
  }

  async function segmentationLoop(now) {
    if (!processing) {
      return;
    }

    if (
      video.readyState >= 2 &&
      !segmentBusy &&
      now - lastSegmentAt >= 50
    ) {
      segmentBusy = true;
      lastSegmentAt = now;

      try {
        await segmenter.send({
          image: video
        });
      } catch (error) {
        console.error(
          "人物辨識失敗：",
          error
        );

        segmentBusy = false;

        setStatus(
          `人物辨識錯誤：${error.message || error}`
        );
      }
    }

    requestAnimationFrame(
      segmentationLoop
    );
  }

  function buildPersonLayer() {
    const width =
      previewCanvas.width;

    const height =
      previewCanvas.height;

    const mirrored =
      facingMode === "user";

    personCtx.clearRect(
      0,
      0,
      width,
      height
    );

    /*
      第一步：先畫完整攝影機影像。
    */
    personCtx.globalCompositeOperation =
      "source-over";

    drawSource(
      personCtx,
      video,
      width,
      height,
      mirrored
    );

    /*
      第二步：用人物遮罩保留人物。

      destination-in 的意思：
      只保留原本影像與遮罩重疊的區域。

      所以結果是：
      人物保留
      背景透明
    */
    personCtx.globalCompositeOperation =
      "destination-in";

    personCtx.drawImage(
      smoothMaskCanvas,
      0,
      0,
      width,
      height
    );

    personCtx.globalCompositeOperation =
      "source-over";
  }

  function renderLoop() {
    const width =
      previewCanvas.width;

    const height =
      previewCanvas.height;

    const mirrored =
      facingMode === "user";

    if (video.readyState >= 2) {
      previewCtx.clearRect(
        0,
        0,
        width,
        height
      );

      previewCtx.save();

      previewCtx.filter =
        "brightness(.46) saturate(.58)";

      drawSource(
        previewCtx,
        video,
        width,
        height,
        mirrored
      );

      previewCtx.restore();

      if (hasMask) {
        buildPersonLayer();

        outlineCtx.clearRect(
          0,
          0,
          width,
          height
        );

        outlineCtx.globalCompositeOperation =
          "source-over";

        outlineCtx.drawImage(
          smoothMaskCanvas,
          0,
          0
        );

        outlineCtx.globalCompositeOperation =
          "source-in";

        outlineCtx.fillStyle =
          "#58f5ff";

        outlineCtx.fillRect(
          0,
          0,
          width,
          height
        );

        outlineCtx.globalCompositeOperation =
          "source-over";

        const distance =
          Math.max(
            3,
            Math.round(width / 240)
          );

        previewCtx.save();

        previewCtx.globalAlpha =
          0.9;

        previewCtx.shadowColor =
          "#58f5ff";

        previewCtx.shadowBlur =
          12;

        [
          [-distance, 0],
          [distance, 0],
          [0, -distance],
          [0, distance],
          [-distance, -distance],
          [distance, -distance],
          [-distance, distance],
          [distance, distance]
        ].forEach(
          ([x, y]) => {
            previewCtx.drawImage(
              outlineCanvas,
              x,
              y
            );
          }
        );

        previewCtx.restore();

        previewCtx.drawImage(
          personCanvas,
          0,
          0
        );

        sendCtx.globalCompositeOperation =
          "source-over";

        sendCtx.fillStyle =
          "#00ff00";

        sendCtx.fillRect(
          0,
          0,
          width,
          height
        );

        sendCtx.drawImage(
          personCanvas,
          0,
          0
        );
      }
    }

    requestAnimationFrame(
      renderLoop
    );
  }

  async function connectToScreen() {
    const roomId =
      params.get("room");

    if (!roomId) {
      setStatus(
        "手機測試模式：尚未連接大螢幕"
      );

      return;
    }

    if (
      typeof sendCanvas.captureStream !==
      "function"
    ) {
      const error =
        new Error(
          "此瀏覽器不支援 Canvas captureStream()"
        );

      error.name =
        "NotSupportedError";

      throw error;
    }

    const outgoingStream =
      sendCanvas.captureStream(24);

    peer =
      createPeer();

    peer.on(
      "open",
      async () => {
        setStatus(
          "正在連接大螢幕…"
        );

        call =
          peer.call(
            roomId,
            outgoingStream
          );

        if (!call) {
          setStatus(
            "無法建立影像通話"
          );

          return;
        }

        await optimizeOutgoingVideo(
          call,
          outgoingStream
        );

        if (call.peerConnection) {
          call.peerConnection.addEventListener(
            "connectionstatechange",
            () => {
              setStatus(
                `連線：${call.peerConnection.connectionState}`
              );
            }
          );
        }
      }
    );

    peer.on(
      "error",
      (error) => {
        console.error(
          "PeerJS 配對錯誤：",
          error
        );

        setStatus(
          `配對錯誤：${error.type || error.message || error}`
        );
      }
    );
  }

  startBtn.addEventListener(
    "click",
    async () => {
      startBtn.disabled =
        true;

      setStatus(
        "正在載入人物辨識…"
      );

      try {
        if (typeof SelfieSegmentation === "undefined") {
          const error =
            new Error(
              "MediaPipe Selfie Segmentation 尚未載入"
            );

          error.name =
            "MediaPipeLoadError";

          throw error;
        }

        segmenter =
          createSegmenter(
            updateMask
          );

        await openCamera();

        processing = true;

        requestAnimationFrame(
          segmentationLoop
        );

        requestAnimationFrame(
          renderLoop
        );

        startPanel.classList.add(
          "hidden"
        );

        switchBtn.disabled =
          false;

        await connectToScreen();
      } catch (error) {
        startBtn.disabled =
          false;

        showCameraError(
          "相機啟動失敗",
          error
        );
      }
    }
  );

  switchBtn.addEventListener(
    "click",
    async () => {
      switchBtn.disabled =
        true;

      const previousFacingMode =
        facingMode;

      facingMode =
        facingMode === "user"
          ? "environment"
          : "user";

      try {
        if (call) {
          call.close();
          call = null;
        }

        if (peer) {
          peer.destroy();
          peer = null;
        }

        await openCamera();
        await connectToScreen();
      } catch (error) {
        facingMode =
          previousFacingMode;

        showCameraError(
          "切換鏡頭失敗",
          error
        );
      } finally {
        switchBtn.disabled =
          false;
      }
    }
  );

  if (isLineBrowser()) {
    status.textContent =
      "偵測到 LINE 內建瀏覽器；若相機失敗，請改用 Safari 或 Chrome 開啟。";
  }
}
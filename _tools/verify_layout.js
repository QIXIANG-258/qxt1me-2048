/* 极简布局验证：棋盘内框 → 期望 → 实测 → 偏差 */
"use strict";
const fs=require("fs"),os=require("os"),path=require("path"),http=require("http"),crypto=require("crypto");
const {spawn}=require("child_process");
const EDGE="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT=9399;const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function wsConnect(url){return new Promise((res,rej)=>{const u=new URL(url);const k=crypto.randomBytes(16).toString("base64");
const r=http.request({host:u.hostname,port:u.port,path:u.pathname+u.search,headers:{Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Key":k,"Sec-WebSocket-Version":"13"}});
r.on("error",rej);r.end();r.on("upgrade",(_,s)=>{s.setNoDelay(true);res({socket:s});});});}
function wsSend(s,str){const p=Buffer.from(str,"utf8");const len=p.length;let h;if(len<126)h=Buffer.from([0x81,0x80|len]);
else if(len<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=0xfe;h.writeUInt16BE(len,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0xff;h.writeBigUInt64BE(BigInt(len),2);}
const m=crypto.randomBytes(4),o=Buffer.alloc(len);for(let i=0;i<len;i++)o[i]=p[i]^m[i%4];s.write(Buffer.concat([h,m,o]));}
function parse(on){let b=Buffer.alloc(0),f=[];return(c)=>{b=Buffer.concat([b,c]);for(;;){if(b.length<2)return;const fin=(b[0]&0x80)!==0,op=b[0]&0x0f;let len=b[1]&0x7f,off=2;
if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;len=Number(b.readBigUInt64BE(2));off=10;}
if(b.length<off+len)return;const pl=b.slice(off,off+len);b=b.slice(off+len);if(op===0x1||op===0x0||op===0x2)f.push(pl);if(fin){on(Buffer.concat(f).toString("utf8"));f=[];}}}};
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"edge-vl-"));
  const ch=spawn(EDGE,["--headless=new","--disable-gpu","--no-proxy-server","--no-first-run","--remote-debugging-port="+PORT,"--user-data-dir="+tmp,"--window-size=1280,900","about:blank"],{stdio:"ignore"});
  process.on("exit",()=>{try{ch.kill();}catch(e){}});
  let tgt=null;for(let i=0;i<60&&!tgt;i++){await sleep(300);try{const b=await new Promise((res,rej)=>http.get({host:"127.0.0.1",port:PORT,path:"/json/list"},(r)=>{let d="";r.on("data",(c)=>(d+=c));r.on("end",()=>res(d));}).on("error",rej));
    tgt=JSON.parse(b).find(t=>t.type==="page"&&t.webSocketDebuggerUrl)||null;}catch(e){}}
  if(!tgt){process.exit(2);}
  const conn=await wsConnect(tgt.webSocketDebuggerUrl);let id=0;const w=new Map();
  conn.socket.on("data",parse((raw)=>{let m;try{m=JSON.parse(raw);}catch(e){return;}
    if(m.id&&w.has(m.id)){const x=w.get(m.id);w.delete(m.id);m.error?x.reject(new Error(JSON.stringify(m.error))):x.resolve(m.result);return;}}));
  function send(method,params){const i=++id;return new Promise((res,rej)=>{w.set(i,{resolve:res,reject:rej});wsSend(conn.socket,JSON.stringify({id:i,method,params:params||{}}));setTimeout(()=>{if(w.has(i)){w.delete(i);rej(new Error("timeout"));}},20000);});}
  const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  await send("Runtime.enable");await send("Page.enable");
  await send("Page.navigate",{url:"http://127.0.0.1:8793/index.html"});await sleep(2000);
  for(let i=0;i<30;i++){try{if(await ev("document.querySelectorAll('#tiles .tile').length")>=2)break;}catch(e){}await sleep(250);}

  const d=await ev(`(function(){
    var b=document.getElementById('board');
    var tEl=document.getElementById('tiles');
    var tiles=[].slice.call(document.querySelectorAll('#tiles .tile'));
    var cells=[].slice.call(document.querySelectorAll('.cells .cell'));
    function r(e){var x=e.getBoundingClientRect();return {w:+x.width.toFixed(2),h:+x.height.toFixed(2),l:+x.left.toFixed(2),t:+x.top.toFixed(2)};}
    var br=b.getBoundingClientRect();
    return {
      board: r(b),
      tilesEl: r(tEl),
      cell: r(cells[0]),
      cellPos: [r(cells[0]), r(cells[4]), r(cells[5])],   // (0,0) (1,0) (1,1)
      tiles: tiles.map(function(t){ var rt=r(t); return { v:t.dataset.v, x:t.style.getPropertyValue('--x'), y:t.style.getPropertyValue('--y'), w:rt.w, h:rt.h, l:rt.l-br.l, t:rt.t-br.t }; }),
      cssStep: tEl.style.getPropertyValue('--step'),
      cssStepY: tEl.style.getPropertyValue('--step-y'),
      cssCellPx: tEl.style.getPropertyValue('--cell-px')
    };
  })()`);
  console.log(JSON.stringify(d,null,2));

  // 断言：tile 位置必须等于 (cell.x + x * stepX - board.l, cell.y + y * stepY - board.t)
  const cb = d.cellPos[0], c10 = d.cellPos[1], c11 = d.cellPos[2];
  const stepX = c10.l - cb.l, stepY = c11.t - cb.t;
  console.log("\n期望 stepX = " + stepX.toFixed(2) + "  CSS 写入 " + d.cssStep);
  console.log("期望 stepY = " + stepY.toFixed(2) + "  CSS 写入 " + d.cssStepY);
  let bad = 0;
  d.tiles.forEach(function(t){
    const expectL = cb.l + t.x * stepX - d.board.l;
    const expectT = cb.t + t.y * stepY - d.board.t;
    const dl = Math.abs(t.l - expectL);
    const dt = Math.abs(t.t - expectT);
    if (dl > 1 || dt > 1) { bad++; console.log("  ✗ tile " + t.v + " ("+t.x+","+t.y+") 实测 ("+t.l.toFixed(1)+","+t.t.toFixed(1)+") 期望 ("+expectL.toFixed(1)+","+expectT.toFixed(1)+")"); }
  });
  if (!bad) console.log("\n✓ 全部 tile 位置对齐到网格");
})().catch(e=>{console.error(e.message);process.exit(2);});
/* 截图核验布局：开 2560×1600，截一张存到 _shots/ */
"use strict";
const fs=require("fs"),os=require("os"),path=require("path"),http=require("http"),crypto=require("crypto");
const {spawn}=require("child_process");
const EDGE="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT=9401;const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
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
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"edge-sh-"));
  const ch=spawn(EDGE,["--headless=new","--disable-gpu","--no-proxy-server","--no-first-run","--remote-debugging-port="+PORT,"--user-data-dir="+tmp,"--window-size=2560,1600","about:blank"],{stdio:"ignore"});
  process.on("exit",()=>{try{ch.kill();}catch(e){}});
  let tgt=null;for(let i=0;i<60&&!tgt;i++){await sleep(300);try{const b=await new Promise((res,rej)=>http.get({host:"127.0.0.1",port:PORT,path:"/json/list"},(r)=>{let d="";r.on("data",(c)=>(d+=c));r.on("end",()=>res(d));}).on("error",rej));
    tgt=JSON.parse(b).find(t=>t.type==="page"&&t.webSocketDebuggerUrl)||null;}catch(e){}}
  if(!tgt){process.exit(2);}
  const conn=await wsConnect(tgt.webSocketDebuggerUrl);let id=0;const w=new Map();
  conn.socket.on("data",parse((raw)=>{let m;try{m=JSON.parse(raw);}catch(e){return;}
    if(m.id&&w.has(m.id)){const x=w.get(m.id);w.delete(m.id);m.error?x.reject(new Error(JSON.stringify(m.error))):x.resolve(m.result);return;}}));
  function send(method,params){const i=++id;return new Promise((res,rej)=>{w.set(i,{resolve:res,reject:rej});wsSend(conn.socket,JSON.stringify({id:i,method,params:params||{}}));setTimeout(()=>{if(w.has(i)){w.delete(i);rej(new Error("timeout"));}},30000);});}
  await send("Page.enable");
  await send("Page.navigate",{url:"http://127.0.0.1:8793/index.html"});await sleep(2500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const out = path.join("D:\\QX_t1me_plan\\05-game-2048", "_shots", "verify_fix.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved " + out + " " + shot.data.length + " base64 chars");
})().catch(e=>{console.error(e.message);process.exit(2);});
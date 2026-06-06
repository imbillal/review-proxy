// review-proxy/src/overlay-runtime.ts
// Browser-side overlay runtime, injected before </body> by the HTML rewriter.
// Adapted from review_api/src/lib/overlay-runtime.ts for the subdomain proxy:
// viewport-relative coordinates, strict origin checks, new-window interception.

/** Returns the IIFE source with the parent app origin baked in. */
export function buildOverlayRuntime(appOrigin: string): string {
  return `
(function(){
  var APP_ORIGIN = ${JSON.stringify(appOrigin)};
  if (!window.parent || window.parent === window) return;
  function post(msg){ try { parent.postMessage(msg, APP_ORIGIN); } catch(e){} }

  var comments = [];
  var mode = "comment";

  function currentPageUrl(){ return location.pathname + location.search + location.hash; }

  function textHash(el){
    var t = (el.textContent || "").slice(0,120).trim(), h = 0;
    for (var i=0;i<t.length;i++) h = ((h<<5)-h+t.charCodeAt(i))|0;
    return el.tagName.toLowerCase()+":"+t.length+":"+h;
  }
  function buildPath(el){
    var parts=[], cur=el;
    while (cur && cur.tagName !== "BODY"){
      var p=cur.parentElement, idx=p?Array.prototype.indexOf.call(p.children,cur):0;
      parts.unshift(cur.tagName.toLowerCase()+"["+idx+"]"); cur=p;
    }
    return parts.join("/");
  }
  function findByPath(path){
    var segs=path.split("/"), node=document.body;
    for (var i=0;i<segs.length;i++){
      if (!node) return null;
      var m=segs[i].match(/^(\\w+)\\[(\\d+)\\]$/); if (!m) return null;
      var child=node.children[Number(m[2])];
      if (!child || child.tagName.toLowerCase()!==m[1]) return null;
      node=child;
    }
    return node;
  }
  function esc(s){ try { return CSS.escape(s); } catch(e){ return s; } }
  function segmentFor(el){
    var parent=el.parentElement, tag=el.tagName.toLowerCase();
    if (!parent) return tag;
    var idx=Array.prototype.indexOf.call(parent.children,el);
    if (el.id){ try { var s="#"+esc(el.id); if (document.querySelectorAll(s).length===1) return s; } catch(e){} }
    if (el.classList && el.classList.length){
      for (var i=0;i<el.classList.length;i++){
        var cls=el.classList[i], count=0;
        for (var j=0;j<parent.children.length;j++){
          var c=parent.children[j];
          if (c.classList && c.classList.contains(cls)) count++;
        }
        if (count===1) return "."+esc(cls);
      }
      return tag+":nth-child("+(idx+1)+")."+esc(el.classList[0]);
    }
    return tag+":nth-child("+(idx+1)+")";
  }
  function genSelector(el){
    if (!el || el===document.body) return "body";
    var parts=[], cur=el;
    while (cur && cur.parentElement && cur!==document.body){ parts.unshift(segmentFor(cur)); cur=cur.parentElement; }
    return "body > "+parts.join(" > ");
  }
  function resolve(c){
    var candidate=null;
    if (c.path){ var el=findByPath(c.path); if (el){ if (!c.textHash||textHash(el)===c.textHash) return el; candidate=el; } }
    if (c.selector){
      try {
        var matches=document.querySelectorAll(c.selector);
        for (var i=0;i<matches.length;i++){ if (!c.textHash||textHash(matches[i])===c.textHash) return matches[i]; }
        if (matches.length>0 && !candidate) candidate=matches[0];
      } catch(e){}
    }
    if (c.textHash){
      var tag=c.textHash.split(":")[0], list=document.getElementsByTagName(tag);
      for (var j=0;j<list.length;j++){ if (textHash(list[j])===c.textHash) return list[j]; }
    }
    return candidate;
  }

  function sendPositions(){
    var out={};
    for (var i=0;i<comments.length;i++){
      var c=comments[i], el=resolve(c);
      if (!el){ out[c.id]={x:0,y:0,visible:false}; continue; }
      var r=el.getBoundingClientRect();
      var x=r.left+r.width*(c.xPct||0)/100;
      var y=r.top+r.height*(c.yPct||0)/100;
      var vis=x>=0&&y>=0&&x<=window.innerWidth&&y<=window.innerHeight;
      out[c.id]={x:x,y:y,visible:vis};
    }
    post({type:"pinion:positions",positions:out,
      docHeight:document.documentElement.scrollHeight,pageUrl:currentPageUrl()});
  }

  function onClick(e){
    var t=e.target;
    var a=t.closest&&t.closest("a");
    if (mode!=="comment"){
      // read mode: let same-tab links navigate; only stop new windows
      if (a && (a.target==="_blank")) e.preventDefault();
      return;
    }
    if (a) e.preventDefault();
    e.stopPropagation();
    if (!t || t===document.body) return;
    var r=t.getBoundingClientRect();
    var xPct=Math.max(0,Math.min(100,((e.clientX-r.left)/r.width)*100));
    var yPct=Math.max(0,Math.min(100,((e.clientY-r.top)/r.height)*100));
    post({type:"pinion:click",selector:genSelector(t),path:buildPath(t),textHash:textHash(t),
      xPct:xPct,yPct:yPct,x:e.clientX,y:e.clientY,pageUrl:currentPageUrl()});
  }

  // Keep new-window navigations inside the frame's flow rather than escaping it.
  var origOpen=window.open;
  window.open=function(){ return null; };
  void origOpen;

  var lastPageUrl=currentPageUrl();
  function emitPageUrl(){
    var u=currentPageUrl();
    if (u!==lastPageUrl){ lastPageUrl=u; post({type:"pinion:page-url",pageUrl:u}); sendPositions(); }
  }
  ["pushState","replaceState"].forEach(function(name){
    var orig=history[name];
    history[name]=function(){ var r=orig.apply(this,arguments); setTimeout(emitPageUrl,0); return r; };
  });
  window.addEventListener("popstate",emitPageUrl);

  window.addEventListener("message",function(e){
    if (e.origin!==APP_ORIGIN) return;
    var d=e.data;
    if (!d||typeof d!=="object") return;
    if (d.type==="pinion:set-comments"){ comments=d.comments||[]; sendPositions(); }
    else if (d.type==="pinion:set-mode"){ mode=d.mode; }
  });

  document.addEventListener("click",onClick,true);
  window.addEventListener("scroll",sendPositions,{passive:true});
  window.addEventListener("resize",sendPositions);
  if ("ResizeObserver" in window){ try { new ResizeObserver(sendPositions).observe(document.body); } catch(e){} }

  function ready(){
    var doc=document.documentElement;
    post({type:"pinion:ready",
      width:Math.max(doc.scrollWidth,doc.clientWidth),
      height:Math.max(doc.scrollHeight,doc.clientHeight),
      pageUrl:currentPageUrl()});
    sendPositions();
  }
  if (document.readyState==="complete") ready();
  else window.addEventListener("load",ready);
})();
`.trim();
}

/**
 * Best-effort neutralizer injected at the start of <head> (§6). Runs before any
 * page script. Two jobs:
 *  1. Hide that we're framed (frameElement/document.domain).
 *  2. Shim localStorage/sessionStorage. In a cross-site iframe with third-party
 *     storage blocked, even *reading* `window.localStorage` throws SecurityError;
 *     SPAs that touch storage on boot then crash (e.g. Next.js client exception →
 *     "page could not be loaded"). When the real storage is unusable we install an
 *     in-memory fallback so the page renders. Non-persistent, which is fine for a
 *     review preview. No-op when storage works (first-party / unblocked).
 */
export const FRAME_BUST_SCRIPT = `
(function(){
  try { Object.defineProperty(window,"frameElement",{get:function(){return null;},configurable:true}); } catch(e){}
  try { Object.defineProperty(document,"domain",{get:function(){return location.hostname;},set:function(){},configurable:true}); } catch(e){}
  function shimStorage(name){
    try { var s=window[name]; s.setItem("__pinion_probe","1"); s.removeItem("__pinion_probe"); return; } catch(e){}
    var m=Object.create(null);
    var store={
      getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},
      setItem:function(k,v){m[String(k)]=String(v);},
      removeItem:function(k){delete m[String(k)];},
      clear:function(){m=Object.create(null);},
      key:function(i){var ks=Object.keys(m);return (i>=0&&i<ks.length)?ks[i]:null;}
    };
    try { Object.defineProperty(store,"length",{get:function(){return Object.keys(m).length;}}); } catch(e){}
    try { Object.defineProperty(window,name,{value:store,configurable:true,writable:true}); } catch(e){}
  }
  shimStorage("localStorage");
  shimStorage("sessionStorage");
})();
`.trim();

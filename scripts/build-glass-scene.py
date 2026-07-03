#!/usr/bin/env python3
"""
build-glass-scene.py — generate glass-scene.html from the glass-500 engine.

Reuses the EXACT engine (traits + geometry + materials + build) by slicing the
module up to the end of build(), then appends a multi-token composition tail:
several diverse bioms staggered in depth on ONE canvas (some nearer, some
farther), framed so nothing is cropped, each gently rocking, seamless loop.

Regenerate whenever the engine changes:  python3 scripts/build-glass-scene.py
"""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "glass-500.html")).read()
mod = re.search(r'<script type="module">([\s\S]*?)</script>', src).group(1)

# keep everything up to (and including) build()'s closing brace
marker = "return{node:G,t};\n}"
engine = mod[: mod.index(marker) + len(marker)]

TAIL = r"""

// ---- composition: several diverse bioms, depth-staggered on ONE canvas ----
try{
const Q=new URLSearchParams(location.search);
const ids=(Q.get('ids')||'1,2,3,4,5,6,7,8,9').split(',').map(s=>parseInt(s,10)).filter(Boolean);
const root=new THREE.Group();scene.add(root);
const nodes=[];
ids.forEach((id,i)=>{
  const {node}=build(id);
  node.updateMatrixWorld(true);
  const box=new THREE.Box3();node.traverse(o=>{if(o.isMesh&&!o.userData.thin)box.expandByObject(o);});
  const sph=box.getBoundingSphere(new THREE.Sphere());
  const hr=mb(((id*2654435761)>>>0)^0x51);
  const wrap=new THREE.Group();
  wrap.scale.setScalar((1.57/(sph.radius||1))*(0.85+hr()*0.4));   // normalize (~50% bigger) + size variety
  const cols=Math.ceil(Math.sqrt(ids.length)),rows=Math.ceil(ids.length/cols);
  const col=i%cols,row=Math.floor(i/cols);
  wrap.position.set((col-(cols-1)/2)*2.5+(hr()-0.5)*0.6,
                    ((rows-1)/2-row)*2.5+(hr()-0.5)*0.6,
                    (hr()-0.5)*4.0);                              // depth: nearer / farther
  node.userData.phase=hr()*6.283;
  wrap.add(node);root.add(wrap);nodes.push(node);
});
// centre + frame on the BODY meshes only (symmetric; thin growths may spill a
// touch past the edge, same as the single-token clips) — wide-ish fov for depth
camera.fov=42;camera.updateProjectionMatrix();
function bodyBox(){const b=new THREE.Box3();root.updateMatrixWorld(true);
  root.traverse(o=>{if(o.isMesh&&!o.userData.thin)b.expandByObject(o);});return b;}
{const c=bodyBox().getCenter(new THREE.Vector3());root.position.sub(c);}
// frame to the grid's extent (not the bounding sphere) so it fills the frame —
// no big empty corners; edge growths may spill a touch like the single clips
const sz=bodyBox().getSize(new THREE.Vector3());
const half=Math.max(sz.x,sz.y)/2;
const fov=camera.fov*Math.PI/180;camera.position.set(0,0,(half/Math.tan(fov/2))*1.06);camera.lookAt(0,0,0);

function applyNode(node,t){const A=t*W+(node.userData.phase||0);
  const M=node.userData.motion||{};const sw=node.userData.swing||0.6;
  node.rotation.y=Math.sin(A)*sw;
  node.rotation.x=(M.tilt||0)+Math.sin(A*(M.wc||1)+1.7)*(M.wa||0.08);
  node.rotation.z=M.rc?Math.sin(A*M.rc)*M.ra:0;
  node.scale.setScalar(1+Math.sin(A)*0.012);
  node.traverse(o=>{const u=o.userData;
    if(u.orbit)o.rotation.y=A*u.orbit;
    if(u.pulse!==undefined)o.scale.setScalar(1+Math.sin(A*2.0+u.pulse)*0.07);});}
window.__seekAll=t=>{uTime.value=t;for(const n of nodes)applyNode(n,t);renderer.render(scene,camera);};
window.__readyAll=()=>true;window.__LOOP=LOOP;

function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();
let t0=performance.now();
function loop(){const t=(performance.now()-t0)/1000;window.__seekAll(t);requestAnimationFrame(loop);}
if(Q.has('still'))window.__seekAll(0);else loop();
}catch(e){window.__sceneErr=(e&&e.stack)||String(e);}
"""

html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Glass · scene</title>
<style>
  html,body{margin:0;height:100%;background:#fff;overflow:hidden;}
  #c{display:block;width:100vw;height:100vh;}
</style>
</head>
<body>
<canvas id="c"></canvas>
<script type="importmap">{ "imports": { "three": "/vendor/three.module.js" } }</script>
<script type="module">
""" + engine + TAIL + """
</script>
</body>
</html>
"""
open(os.path.join(ROOT, "glass-scene.html"), "w").write(html)
print("wrote glass-scene.html  (engine %d chars + composition tail)" % len(engine))

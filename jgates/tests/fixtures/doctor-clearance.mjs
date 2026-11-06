import {Vector3,Matrix4} from 'three';

// Conservative skin-space clearance: actual sleeve ring centers and glove
// bounding boxes, rather than assuming the pose's hand targets are collision-free.
export function armClearanceProbe(actor){
  const {rig:r}=actor;
  const points=r.binaurals.flatMap(m=>m.geometry.parameters.path.getPoints(90));
  const tmp=new Vector3(),dir=new Vector3(),nearest=new Vector3(),mapped=new Vector3();
  r.arms.forEach(a=>a.hand.children[0].geometry.computeBoundingBox());
  return ()=>{
    let minimum=Infinity,part='';
    for(const [i,arm] of r.arms.entries()){
      const p=arm.sleeve.geometry.attributes.position,centers=[];
      for(let ring=0;ring<=24;ring++){
        const center=new Vector3();
        for(let side=0;side<14;side++)center.add(tmp.fromBufferAttribute(p,ring*15+side));
        centers.push(center.multiplyScalar(1/14));
      }
      const glove=arm.hand.children[0];
      const inverse=new Matrix4().copy(glove.matrixWorld).invert().multiply(r.skin.matrixWorld);
      for(const q of points){
        for(let j=0;j<24;j++){
          dir.subVectors(centers[j+1],centers[j]);
          const t=Math.max(0,Math.min(1,tmp.subVectors(q,centers[j]).dot(dir)/dir.lengthSq()));
          nearest.copy(centers[j]).addScaledVector(dir,t);
          const gap=q.distanceTo(nearest)-.151-.043;
          if(gap<minimum){minimum=gap;part=`arm-${i}`;}
        }
        mapped.copy(q).applyMatrix4(inverse);
        const gap=glove.geometry.boundingBox.distanceToPoint(mapped)*1.1-.043;
        if(gap<minimum){minimum=gap;part=`glove-${i}`;}
      }
    }
    return {minimum,part};
  };
}

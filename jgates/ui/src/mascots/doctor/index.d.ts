import type {Group} from 'three';
export type DoctorState='checking'|'needs-you'|'ok'|'error';
export interface DoctorOptions {state?:DoctorState;reducedMotion?:boolean;elasticity?:number;}
export const DOCTOR_STATES:Readonly<Record<DoctorState,{label:string;short:string;symbol:string;description:string}>>;
export class DoctorMascot extends EventTarget {
  constructor(options?:DoctorOptions);
  object:Group;state:DoctorState;reason:string;elasticity:number;reducedMotion:boolean;
  setState(state:DoctorState,options?:{reason?:string}):this;
  setReducedMotion(enabled:boolean):this;
  replay():this;update(deltaSeconds:number):void;
  inspect():Record<string,unknown>;dispose():void;
}
export class DoctorViewer {
  constructor(options:{canvas:HTMLCanvasElement;viewports:HTMLElement[];state?:DoctorState;reducedMotion?:boolean;onError?:(error:Error)=>void});
  actor:DoctorMascot;angle:number;zoom:number;speed:number;paused:boolean;
  setPaused(enabled:boolean):void;setReducedMotion(enabled:boolean):void;
  invalidate():void;render(deltaSeconds?:number):void;inspect():Record<string,unknown>;dispose():void;
}
export function mountDoctor(element:HTMLElement,options?:{reducedMotion?:boolean;onError?:(error:Error)=>void}):{
  actor:DoctorMascot;viewer:DoctorViewer;setState(state:DoctorState):void;dispose():void;
};

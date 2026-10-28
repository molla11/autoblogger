'use client';
import {X,Loader2,ArrowUpRight,CheckCircle2,AlertCircle} from 'lucide-react';
import type {ReactNode} from 'react';
export function Spinner(){return <Loader2 size={16} className="spin" aria-label="진행 중"/>}
export function Empty({icon,title,children,action}:{icon?:ReactNode;title:string;children?:ReactNode;action?:ReactNode}){return <div className="empty">{icon&&<div className="empty-icon">{icon}</div>}<h3>{title}</h3><p>{children}</p>{action}</div>}
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}){return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide?'wide':''}`}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="닫기"><X size={20}/></button></header>{children}</section></div>}
export function Badge({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={`badge ${tone}`}>{children}</span>}
export function Toast({message,onClose,error=false}:{message:string;onClose:()=>void;error?:boolean}){return <div role={error?'alert':'status'} className={`toast ${error?'error':''}`}>{error?<AlertCircle size={18}/>:<CheckCircle2 size={18}/>}<span>{message}</span><button onClick={onClose} aria-label="알림 닫기"><X size={16}/></button></div>}
export function LinkOut({href,children}:{href:string;children:ReactNode}){return <a href={/^https?:\/\//.test(href)?href:'#'} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={14}/></a>}
export const reviewLabels:Record<string,string>={needs_review:'확인 필요',supported:'기록이 뒷받침함',insufficient:'근거 부족',conflict:'기록과 충돌',unknown:'판단 불가'};
export const jobLabels:Record<string,string>={generate:'초안 작성',summarize:'타임라인 요약',suggest:'AI 수정 제안',verify:'근거 검토',publish:'Ghost 동기화'};
export const statusLabels:Record<string,string>={queued:'대기 중',running:'진행 중',completed:'완료',failed:'실패',cancelled:'취소됨',draft:'Ghost 초안',published:'공개',local:'내 보관함'};

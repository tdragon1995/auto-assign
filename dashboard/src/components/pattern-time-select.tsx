"use client";
const timeField="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60";
/** Shift times are chosen on the half hour (06:00, 06:30, …), never typed to the minute. */
const patternTimes=Array.from({length:48},(_,i)=>`${String(Math.floor(i/2)).padStart(2,"0")}:${i%2 ? "30" : "00"}`);
export function PatternTimeSelect({label,value,onChange,disabled}:{label:string;value:string;onChange:(value:string)=>void;disabled:boolean}){
 return <select aria-label={label} className={`${timeField} min-w-0 w-full px-2`} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>
  <option value="">--:--</option>
  {/* Keep a saved off-grid time visible without offering it as a new choice. */}
  {value&&!patternTimes.includes(value)&&<option value={value} disabled>{value}</option>}
  {patternTimes.map(time=><option key={time} value={time}>{time}</option>)}
 </select>;
}

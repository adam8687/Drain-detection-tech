import {ApiError} from './validation.js';
export class SupabaseEmailStore{
 constructor(url,key,fetcher=fetch){this.url=url;this.key=key;this.fetcher=fetcher;}
 async request(path,options={}){let r;try{r=await this.fetcher(`${this.url}/rest/v1/${path}`,{...options,headers:{apikey:this.key,...(this.key.startsWith('eyJ')?{Authorization:`Bearer ${this.key}`}:{}),'Content-Type':'application/json',Prefer:'return=representation',...options.headers},signal:AbortSignal.timeout(10000)});}catch{throw new ApiError(503,'email_storage_unavailable','Email settings are temporarily unavailable.');}if(!r.ok)throw new ApiError(503,'email_storage_unavailable','Email setup requires the notifications database update.');return r.status===204?[]:r.json();}
 async references(fixture){return this.request(`drain_email_references?fixture_id=eq.${encodeURIComponent(fixture)}&select=fixture_id,cycle_id,started_at,depth_mm,duration_seconds&order=started_at.asc&limit=50`);}
 async preference(fixture,user){return(await this.request(`drain_email_preferences?fixture_id=eq.${encodeURIComponent(fixture)}&user_id=eq.${encodeURIComponent(user)}&select=*&limit=1`))[0]??null;}
 async savePreference(p){await this.request('drain_email_preferences?on_conflict=fixture_id,user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(p)});}
 async claim(limit){return this.request('rpc/claim_drain_emails',{method:'POST',body:JSON.stringify({p_limit:limit})});}
 async seal(job,recipient,payload){await this.request('rpc/update_drain_email',{method:'POST',body:JSON.stringify({p_id:job.id,p_lease:job.lease_token,p_action:'seal',p_values:{recipient,payload}})});}
 async finish(job,status,provider_id=null){await this.request('rpc/update_drain_email',{method:'POST',body:JSON.stringify({p_id:job.id,p_lease:job.lease_token,p_action:status,p_values:{provider_id}})});}
 async retry(job){await this.request('rpc/update_drain_email',{method:'POST',body:JSON.stringify({p_id:job.id,p_lease:job.lease_token,p_action:'retry',p_values:{}})});}
}

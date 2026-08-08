export const dashboardClient = String.raw`
const el=(id)=>document.getElementById(id);
const list=(value)=>Array.isArray(value)?value:[];
const esc=(value)=>String(value??"").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
const ago=(value)=>{if(!value)return "never";const seconds=Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000));if(seconds<5)return "now";if(seconds<60)return seconds+"s ago";const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+"m ago";const hours=Math.floor(minutes/60);if(hours<24)return hours+"h ago";return Math.floor(hours/24)+"d ago"};
const duration=(value)=>{if(!value)return "waiting";const seconds=Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000));if(seconds<60)return seconds+"s";const minutes=Math.floor(seconds/60);return minutes<60?minutes+"m "+seconds%60+"s":Math.floor(minutes/60)+"h "+minutes%60+"m"};
const elapsed=(value)=>{const seconds=Math.max(0,Math.round(Number(value||0)/1000));if(seconds<60)return seconds+"s";const minutes=Math.floor(seconds/60);return minutes<60?minutes+"m "+seconds%60+"s":Math.floor(minutes/60)+"h "+minutes%60+"m"};
const seconds=(value)=>Math.max(0,Math.round(Number(value||0)/1000))+"s";
const short=(value,length=8)=>value?String(value).slice(0,length):"—";
const badge=(value)=>'<span class="badge '+esc(value)+'">'+esc(String(value).replaceAll("_"," "))+'</span>';
const empty=(copy)=>'<div class="empty">'+esc(copy)+'</div>';
const safeLink=(url,label)=>{if(!url||!/^https:\/\/(github\.com|discord\.com\/channels)\//.test(url))return "";return '<a class="link" target="_blank" rel="noreferrer" href="'+esc(url)+'">'+esc(label)+'</a>'};
const tooltipRow=(name,status,detail)=>'<div class="tooltip-row"><span class="status-dot '+esc(status)+'" aria-hidden="true"></span><span>'+esc(name)+'</span><span>'+esc(String(status).replaceAll("_"," ")+" · "+detail)+'</span></div>';
let latestSnapshot=null;
let detailState={key:null,data:null,loading:false,error:null};
let refreshInFlight=null;
const sectionFingerprints=new Map();
let traceExpanded=false;
let searchState={results:[],index:0,restoreFocus:null};
const loadingTransitionMs=200;
const requestedFilter=new URLSearchParams(location.search).get("filter");
const requestedType=new URLSearchParams(location.search).get("type");
let activityFilter=["all","running","waiting","blocked","failed","done"].includes(requestedFilter)?requestedFilter:"all";
let activityType=["all","conversation","improvement","code_change","release","system"].includes(requestedType)?requestedType:"all";
const activityTypeLabels={all:"All types",conversation:"Prompts & replies",improvement:"Improvements",code_change:"Code changes",release:"Releases",system:"System"};
const activityRoute=()=>{const match=location.pathname.match(/^\/activity\/([^/]+)\/([^/]+)$/);if(!match)return null;try{return {kind:decodeURIComponent(match[1]),id:decodeURIComponent(match[2])}}catch{return null}};
let initialSelectionHandled=Boolean(activityRoute());
const activityQuery=()=>"?filter="+encodeURIComponent(activityFilter)+(activityType==="all"?"":"&type="+encodeURIComponent(activityType));
const activityPath=(story)=>"/activity/"+encodeURIComponent(story.kind)+"/"+encodeURIComponent(story.id)+activityQuery();
const renderChanged=(key,value,renderSection)=>{const next=JSON.stringify(value);if(sectionFingerprints.get(key)===next)return;sectionFingerprints.set(key,next);renderSection()};
const revealView=(targetId,loaderId)=>{const target=el(targetId);const loader=el(loaderId);target?.classList.add("is-ready");target?.removeAttribute("inert");target?.setAttribute("aria-busy","false");if(!loader||loader.hidden)return;loader.classList.add("is-complete");loader.setAttribute("aria-hidden","true");setTimeout(()=>{loader.hidden=true},loadingTransitionMs)};
const loadingError=(loaderId,message)=>{const loader=el(loaderId);if(!loader)return;loader.classList.add("error");const status=loader.querySelector(".loading-status");if(status)status.textContent=message;const error=loader.querySelector(".loading-error");if(error)error.hidden=false};

function renderSystem(data){
  const services=list(data.services);
  const producers=list(data.producers);
  const deployments=list(data.deployments);
  const telemetryAvailable=Boolean(data.summary.serviceTelemetryAvailable);
  const healthyServices=Number(data.summary.healthyServices||0);
  const serviceCount=Number(data.summary.serviceCount||services.length);
  const healthyProducers=producers.filter((item)=>item.status==="succeeded").length;
  el("service-summary").textContent=telemetryAvailable?healthyServices+"/"+serviceCount+" services":serviceCount+" services · status unavailable";
  el("producer-summary").textContent=healthyProducers+"/"+producers.length+" producers";

  const kubernetes=data.summary.serviceTelemetrySource==="kubernetes";
  el("services-tooltip").innerHTML='<div class="tooltip-title">'+esc(kubernetes?"Kubernetes readiness":"Live process heartbeats")+'</div>'+services.map((service)=>{
    const unavailable=service.status==="unavailable";
    const detail=unavailable?"not reporting":kubernetes?service.instances+"/"+service.desiredInstances+" ready":service.instances+" live · "+ago(service.lastSeenAt);
    return tooltipRow(service.component,service.status,detail);
  }).join("");

  el("producers-tooltip").innerHTML='<div class="tooltip-title">Proof producers</div>'+producers.map((item)=>tooltipRow(item.trigger.replaceAll("_"," "),item.status,item.outcomeCode||ago(item.completedAt||item.startedAt))).join("")+(deployments.length?'<div class="tooltip-divider"></div><div class="tooltip-title">Latest verified release</div><div class="tooltip-copy mono">'+esc(short(deployments[0].revision,10))+" · "+esc(ago(deployments[0].verifiedAt))+"</div>":"");
}

const activityKind=(value,hasParent=false)=>value==="conversation"?(hasParent?"reply":"prompt"):({code_change:"code change",improvement:"improvement",release:"release",system:"system"}[value]||String(value||"activity").replaceAll("_"," "));
const activityLifecycle=(story,active=false)=>{if(active||story.workState==="active"||["queued","running"].includes(story.status))return "running";if(story.workState==="waiting"||story.status==="delivery_pending")return "waiting";if(story.workState==="blocked")return "blocked";if(story.workState==="terminal")return "done";if(story.category==="failure"||story.tone==="danger"||story.tone==="warning")return "failed";return "done"};
const matchesActivityType=(item,type=activityType)=>type==="all"||item.kind===type;
const matchesActivityFilter=(item,filter=activityFilter,active=false)=>matchesActivityType(item)&&(filter==="all"||activityLifecycle(item,active)===filter);
const viewAnchor=()=>{const scroll=el("activity-scroll");if(!scroll||scroll.scrollTop<=0)return null;const story=[...scroll.querySelectorAll("[data-story-id]")].find((item)=>item.getBoundingClientRect().bottom>scroll.getBoundingClientRect().top);return story?{id:story.dataset.storyId,top:story.getBoundingClientRect().top}:null};
const restoreViewAnchor=(anchor)=>{if(!anchor)return;const story=document.querySelector('[data-story-id="'+CSS.escape(anchor.id)+'"]');if(story)el("activity-scroll").scrollBy(0,story.getBoundingClientRect().top-anchor.top)};
const storyIndicator=(story,active)=>{const state=activityLifecycle(story,active);return '<span class="story-mark story-status-indicator" data-state="'+esc(state)+'" role="img" aria-label="Status: '+esc(state)+'" title="'+esc(state)+'"></span>'};
const storyQualifier=(story,active)=>{const state=activityLifecycle(story,active);if(["failed","blocked"].includes(state))return state;if(Number(story.attempts)>1)return story.attempts+" attempts";if(["thread","dm"].includes(story.responseKind))return story.responseKind;return ""};
const storyMeta=(story,active)=>{const qualifier=storyQualifier(story,active);return qualifier?'<span class="story-meta"><span class="story-qualifier">'+esc(qualifier)+'</span></span>':""};
const storyTiming=(story,active)=>{if(active&&story.startedAt)return '<span class="story-duration"><span class="sr-only">Running for </span>'+esc(seconds(Date.now()-new Date(story.startedAt).getTime()))+'</span>';if(!active&&Number.isFinite(story.durationMs))return '<span class="story-latency '+esc(story.latencyTone||"normal")+'"><span class="sr-only">Duration </span>'+esc(seconds(story.durationMs))+'</span>';return ""};
const storyCard=(story,active=false)=>{const selected=detailState.key===story.kind+":"+story.id;return '<a class="story '+esc(story.tone)+(active?' active':'')+(selected?' selected':'')+'" data-story-id="'+esc(story.id)+'" href="'+esc(activityPath(story))+'"'+(selected?' aria-current="true"':'')+'><span class="story-summary">'+storyIndicator(story,active)+'<span class="story-main"><span class="story-title-row"><span class="story-kind">'+esc(activityKind(story.kind,story.hasParent))+'</span>'+storyMeta(story,active)+'</span><span class="story-detail-row">'+storyTiming(story,active)+'<span class="story-title">'+esc(story.title)+'</span></span></span><span class="story-trailing">'+(active?'':'<time datetime="'+esc(story.occurredAt)+'">'+esc(ago(story.occurredAt))+'</time>')+'</span></span></a>'};
const allActivityStories=(data=latestSnapshot)=>{if(!data)return [];return [...new Map([...list(data.activity?.active),...list(data.activity?.recent)].map((item)=>[item.kind+":"+item.id,item])).values()]};
const activitySearchText=(story)=>[story.title,story.summary,story.status,story.branchName,activityKind(story.kind,story.hasParent)].filter(Boolean).join(" ").toLowerCase();
const activitySearchScore=(story,tokens)=>{const title=String(story.title||"").toLowerCase();const text=activitySearchText(story);if(!tokens.every((token)=>text.includes(token)))return -1;return tokens.reduce((score,token)=>score+(title.startsWith(token)?4:title.includes(token)?2:1),0)};
const searchResultCard=(story,index,selected,active)=>'<button id="activity-search-result-'+index+'" class="activity-search-result" type="button" role="option" data-search-index="'+index+'" aria-selected="'+String(selected)+'">'+storyIndicator(story,active)+'<span class="activity-search-copy"><span class="activity-search-meta"><span class="story-kind">'+esc(activityKind(story.kind,story.hasParent))+'</span>'+storyMeta(story,active)+'</span><span class="activity-search-title-row">'+storyTiming(story,active)+'<span class="activity-search-title">'+esc(story.title)+'</span></span></span><time datetime="'+esc(story.occurredAt)+'">'+esc(ago(story.occurredAt))+'</time></button>';
const syncSearchSelection=()=>{const input=el("activity-search-input");const options=[...el("activity-search-results").querySelectorAll("[data-search-index]")];options.forEach((option,index)=>option.setAttribute("aria-selected",String(index===searchState.index)));const selected=options[searchState.index];if(selected){input.setAttribute("aria-activedescendant",selected.id);selected.scrollIntoView({block:"nearest"})}else input.removeAttribute("aria-activedescendant")};
const renderActivitySearch=(query="",preserveIndex=false)=>{const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean);const stories=allActivityStories();const ranked=stories.map((story,order)=>({story,order,score:activitySearchScore(story,tokens)})).filter((item)=>item.score>=0).sort((left,right)=>tokens.length?right.score-left.score||left.order-right.order:left.order-right.order).slice(0,20).map((item)=>item.story);searchState.results=ranked;const route=activityRoute();const routeIndex=route?ranked.findIndex((story)=>story.kind===route.kind&&story.id===route.id):-1;searchState.index=preserveIndex?Math.min(searchState.index,Math.max(0,ranked.length-1)):tokens.length?0:Math.max(0,routeIndex);const activeKeys=new Set(list(latestSnapshot?.activity?.active).map((item)=>item.kind+":"+item.id));el("activity-search-results").innerHTML=ranked.length?ranked.map((story,index)=>searchResultCard(story,index,index===searchState.index,activeKeys.has(story.kind+":"+story.id))).join(""):'<div class="activity-search-empty" role="status">No matching activity</div>';syncSearchSelection()};
const moveSearchSelection=(delta)=>{if(!searchState.results.length)return;searchState.index=(searchState.index+delta+searchState.results.length)%searchState.results.length;syncSearchSelection()};
const closeActivitySearch=()=>{const dialog=el("activity-search");if(dialog.open)dialog.close()};
const openActivitySearch=()=>{const dialog=el("activity-search");if(dialog.open){el("activity-search-input").focus();return}searchState.restoreFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;const input=el("activity-search-input");input.value="";input.setAttribute("aria-expanded","true");renderActivitySearch();dialog.showModal();requestAnimationFrame(()=>input.focus())};
const dayKey=(value)=>{const date=new Date(value);return date.getFullYear()+"-"+(date.getMonth()+1)+"-"+date.getDate()};
const dayLabel=(value)=>{const today=new Date();const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);const key=dayKey(value);if(key===dayKey(today))return "Today";if(key===dayKey(yesterday))return "Yesterday";return new Intl.DateTimeFormat(undefined,{weekday:"long",month:"short",day:"numeric"}).format(new Date(value))};
const exactTime=(value)=>value?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"medium"}).format(new Date(value)):"—";
const detailMetric=(label,value,tone="")=>value==null||value===""?"":'<div class="detail-metric '+esc(tone)+'"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';
const detailLinks=(story)=>{const links=safeLink(story.sourceUrl,"Open source ↗")+safeLink(story.responseUrl,story.responseKind==="dm"?"Open DM ↗":story.responseKind==="thread"?"Open thread ↗":"Open reply ↗")+safeLink(story.pullRequestUrl,"Open pull request ↗");return links?'<div class="detail-links">'+links+'</div>':""};
const traceTime=(value)=>value?new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(value)):"—";
const traceLevel=(tone)=>tone==="danger"?"error":tone==="warning"?"warn":"info";
const traceState=(item)=>item.status||(["error"].includes(item.level)?"failed":item.level==="warn"?"blocked":"done");
const traceType=(value)=>String(value||"event").replaceAll("_"," ");
const traceUsage=(usage)=>{const value=usage&&typeof usage==="object"?usage:{};const tokens=Number(value.total_tokens??value.totalTokens??value.total??0);return Number.isFinite(tokens)&&tokens>0?tokens.toLocaleString()+" tokens":""};
const traceMetadata=(metadata)=>{const value=metadata&&typeof metadata==="object"?metadata:{};const model=value.model||value.requestedModel;const fields=[model?String(model):"",value.reasoningEffort?String(value.reasoningEffort)+" reasoning":"",traceUsage(value.usage),Number.isFinite(value.estimatedCostUsd)?"$"+Number(value.estimatedCostUsd).toFixed(4):"",value.toolName?String(value.toolName):"",value.status?String(value.status).replaceAll("_"," "):"",Number.isFinite(value.outputChars)?Number(value.outputChars).toLocaleString()+" output chars":"",value.latencyBudgetExceeded?"latency budget exceeded":"",Number.isFinite(value.messageCount)?value.messageCount+" messages":"",Number.isFinite(value.toolCount)?value.toolCount+" tools":""];return fields.filter(Boolean)};
const traceItems=(story,detail)=>{
  const items=[];
  const messages=list(detail?.messages);
  for(const message of messages)items.push({id:"message:"+message.id,key:"message:"+message.id,type:message.reply?"response":message.current?"prompt":"message",title:message.author||message.role,summary:message.content||"",status:"done",level:message.deleted?"warn":"info",occurredAt:message.createdAt,durationMs:null,count:1,kind:"message",message,url:message.url,important:Boolean(message.directParent||message.current||message.reply)});
  const events=list(detail?.traceEvents).length?list(detail.traceEvents):list(story.technicalEvents).map((event)=>({id:event.id,type:"event",title:event.label||event.name,summary:"",status:event.level==="error"?"failed":"done",level:event.level,code:event.name,durationMs:null,metadata:{},occurredAt:event.createdAt}));
  for(const event of events)items.push({id:event.id,key:"event:"+(event.code||event.id)+":"+event.level,type:event.type||"event",title:event.title||event.summary||event.code,summary:event.summary||"",status:event.status,level:event.level||"info",code:event.code||"",occurredAt:event.occurredAt,durationMs:event.durationMs,metadata:event.metadata||{},spanId:event.spanId,parentSpanId:event.parentSpanId,count:1,kind:"event",important:["model","tool","context","delivery","response"].includes(event.type)||["error","warn"].includes(event.level)||/(failed|failure|blocked|stalled|retry|queued|completed|delivered)/i.test(event.code||"")});
  const runs=list(story.runs);for(const [index,run] of runs.entries())items.push({id:"run:"+run.id,key:"run:"+run.id,type:"run",title:run.title,summary:String(run.status).replaceAll("_"," "),status:run.tone==="danger"?"failed":"done",level:traceLevel(run.tone),occurredAt:run.occurredAt,durationMs:run.durationMs,count:1,kind:"run",important:index<3||run.tone==="danger"||run.tone==="warning"});
  const grouped=new Map();
  for(const item of items){const group=item.kind==="event"?grouped.get(item.key):null;if(group){group.count+=1;group.firstAt=new Date(item.occurredAt)<new Date(group.firstAt)?item.occurredAt:group.firstAt;group.occurredAt=new Date(item.occurredAt)>new Date(group.occurredAt)?item.occurredAt:group.occurredAt;group.important ||= item.important}else grouped.set(item.key,{...item,firstAt:item.occurredAt})}
  return {items:[...grouped.values()].sort((left,right)=>new Date(left.occurredAt).getTime()-new Date(right.occurredAt).getTime()),total:items.length};
};
const traceTimeCell=(item)=>{const time='<time datetime="'+esc(item.occurredAt)+'">'+esc(traceTime(item.occurredAt))+'</time>';return item.url?'<a class="trace-time-link" target="_blank" rel="noreferrer" href="'+esc(item.url)+'">'+time+'</a>':time};
const traceSummary=(item)=>{if(item.kind==="message"){const unavailable=item.message.deleted?"Deleted message":list(item.message.attachments).length?"":"Message content unavailable";const content=item.summary?'<div class="trace-content">'+discordText(item.summary)+'</div>':unavailable?'<div class="trace-content unavailable">'+unavailable+'</div>':"";return content+messageAttachments(item.message)}const metadata=traceMetadata(item.metadata);return (item.summary?'<span class="trace-summary">'+esc(item.summary)+'</span>':"")+(metadata.length?'<span class="trace-metadata">'+metadata.map((value)=>'<span>'+esc(value)+'</span>').join("")+'</span>':"")+(item.code?'<code>'+esc(item.code)+'</code>':"")+(item.count>1?'<small>Repeated '+esc(item.count)+' times from '+esc(traceTime(item.firstAt))+'</small>':"")};
const traceRow=(item)=>'<div class="trace-row '+esc(item.kind)+(item.message?.current?' current':'')+'">'+traceTimeCell(item)+'<span class="trace-marker story-status-indicator" data-state="'+esc(traceState(item))+'" role="img" aria-label="Status: '+esc(traceState(item))+'"></span><span class="trace-type">'+esc(traceType(item.type))+'</span><div class="trace-copy"><strong>'+esc(item.title)+(item.count>1?' <span>×'+esc(item.count)+'</span>':"")+'</strong>'+traceSummary(item)+'</div>'+(Number.isFinite(item.durationMs)?'<span class="trace-duration">'+esc(seconds(item.durationMs))+'</span>':'<span class="trace-duration"></span>')+'</div>';
const detailTrace=(story,detail)=>{const projected=traceItems(story,detail);if(!projected.items.length)return "";const visible=traceExpanded?projected.items:projected.items.filter((item)=>item.important);const canToggle=visible.length<projected.items.length||traceExpanded&&projected.items.some((item)=>!item.important);const summary=(traceExpanded?"All":"Highlights")+" · "+visible.length+" of "+projected.items.length+(projected.total===projected.items.length?"":" groups · "+projected.total+" records");return '<section class="detail-section trace-section"><div class="trace-heading"><div><h2>Trace</h2><span>'+esc(summary)+'</span></div>'+(canToggle?'<button id="trace-toggle" type="button" aria-expanded="'+String(traceExpanded)+'">'+(traceExpanded?'Show highlights':'Show all '+projected.items.length)+'</button>':"")+'</div><div class="trace-list">'+visible.map(traceRow).join("")+'</div></section>'};
const detailContext=(story)=>{const labels={conversation:"Delivery and execution",code_change:"Repository work",improvement:"Improvement work",release:"Deployment",system:"Background operations"};return labels[story.kind]||"Activity"};
const discordText=(value)=>String(value??"").split("\n").map((line)=>{const subtext=line.startsWith("-# ");const quote=!subtext&&line.startsWith("> ");let text=esc(line.slice(subtext?3:quote?2:0));text=text.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/&lt;@&amp;(\d+)&gt;/g,'<span class="discord-mention" title="Role $1">@role</span>').replace(/&lt;@!?(\d+)&gt;/g,'<span class="discord-mention" title="User $1">@user</span>');return subtext?'<span class="discord-subtext">'+text+'</span>':quote?'<span class="discord-quote">'+text+'</span>':text}).join("\n");
const formatBytes=(value)=>{const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<=0)return "";if(bytes<1024)return bytes+" B";if(bytes<1048576)return Math.round(bytes/1024)+" KB";return (bytes/1048576).toFixed(1)+" MB"};
const messageAttachments=(message)=>list(message.attachments).length?'<div class="discord-attachments">'+list(message.attachments).map((attachment)=>'<div class="discord-attachment"><span class="attachment-icon" aria-hidden="true">FILE</span><span><strong>'+esc(attachment.filename||"Attachment")+'</strong><small>'+esc([attachment.contentType,formatBytes(attachment.sizeBytes)].filter(Boolean).join(" · "))+'</small></span></div>').join("")+'</div>':"";
const detailLoadingShell=()=>'<div class="detail-transition-skeleton" aria-hidden="true"><div class="loading-detail-hero"><span class="skeleton-line w-24"></span><span class="skeleton-line w-52 tall"></span><span class="skeleton-line w-34"></span><div class="loading-detail-metrics">'+Array.from({length:4},()=>'<span><i class="skeleton-line w-34"></i><i class="skeleton-line w-52"></i></span>').join("")+'</div></div><div class="loading-panel loading-detail-section">'+Array.from({length:4},(_,index)=>'<div class="loading-row"><span class="skeleton-dot"></span><span><span class="skeleton-line w-'+(index%2===0?42:34)+'"></span><span class="skeleton-line w-24"></span></span></div>').join("")+'</div></div><span class="sr-only">Loading activity</span>';

function renderActivityDetail(detail,route){
  const story=detail?.story;
  document.body.classList.add("detail-selected");
  el("activity-back").href="/"+activityQuery()+"#activity-panel";
  el("activity-detail-view").setAttribute("aria-busy",String(!story&&!detailState.error));
  if(!story){document.title=(detailState.error?"Activity unavailable":"Loading activity")+" · Console";el("activity-detail").innerHTML=detailState.error?'<section class="detail-empty workspace-empty"><span class="terminal-prompt" aria-hidden="true">!_</span><h2>Activity unavailable</h2><p>This item is outside the current activity window or no longer exists.</p></section>':detailLoadingShell();return}
  document.title=story.title+" · Console";
  const active=Boolean(detail.active);
  const metricItems=[
    detailMetric(active?"Running":"Occurred",active?duration(story.startedAt):exactTime(story.occurredAt)),
    detailMetric("Duration",active?duration(story.startedAt):Number.isFinite(story.durationMs)?elapsed(story.durationMs):null,story.latencyTone),
    detailMetric("Attempts",story.attempts>1?story.attempts:null),
    detailMetric("Branch",story.branchName),
    detailMetric("Runs",story.runCount),
    detailMetric("Successful",story.successCount),
    detailMetric("Failed",story.failureCount,story.failureCount?"danger":""),
    detailMetric("p95 latency",Number.isFinite(story.p95DurationMs)?elapsed(story.p95DurationMs):null),
  ].filter(Boolean);
  const metrics=metricItems.join("");
  el("activity-detail").innerHTML='<article class="detail-hero '+esc(story.tone)+'"><div class="detail-eyebrow"><span class="story-mark" aria-hidden="true"></span><span>'+esc(activityKind(story.kind,story.hasParent))+'</span><span>'+esc(detailContext(story))+'</span></div><div class="detail-title-row"><div><h1>'+esc(story.title)+'</h1><p>'+esc(story.summary||String(story.status).replaceAll("_"," "))+'</p></div>'+badge(story.status)+'</div>'+detailLinks(story)+(metrics?'<section class="detail-metrics metrics-'+esc(metricItems.length)+'" aria-label="Activity facts">'+metrics+'</section>':"")+'</article>'+detailTrace(story,detail);
  el("activity-detail-view").setAttribute("aria-busy","false");
}

function clearActivityDetail(){
  detailState={key:null,data:null,loading:false,error:null};
  traceExpanded=false;
  document.body.classList.remove("detail-selected");
  document.title="Discord AI Agent · Console";
  el("activity-detail-view").setAttribute("aria-busy","false");
  el("activity-detail").innerHTML='<div class="detail-placeholder"><span class="terminal-prompt" aria-hidden="true">›_</span><h2>Select activity</h2><p>Choose an item to inspect its context and execution details.</p></div>';
  if(latestSnapshot)renderActivity(latestSnapshot);
}
const mobileWorkspace=()=>matchMedia("(max-width: 760px)").matches;
const focusActivityList=()=>{if(mobileWorkspace())requestAnimationFrame(()=>document.querySelector('[data-activity-filter][aria-pressed="true"]')?.focus())};
const selectInitialActivity=(data)=>{if(initialSelectionHandled)return;initialSelectionHandled=true;if(activityRoute()||mobileWorkspace())return;const activeKeys=new Set(list(data.activity?.active).map((item)=>item.kind+":"+item.id));const stories=[...new Map([...list(data.activity?.active),...list(data.activity?.recent)].map((item)=>[item.kind+":"+item.id,item])).values()];const story=stories.find((item)=>matchesActivityFilter(item,activityFilter,activeKeys.has(item.kind+":"+item.id)));if(!story)return;history.replaceState(null,"",activityPath(story));const route=activityRoute();if(route)refreshActivityDetail(route)};

function renderActivity(data){
  const anchor=viewAnchor();
  const all=[...new Map([...list(data.activity?.active),...list(data.activity?.recent)].map((item)=>[item.kind+":"+item.id,item])).values()];
  const activeKeys=new Set(list(data.activity?.active).map((item)=>item.kind+":"+item.id));
  document.querySelectorAll("[data-activity-filter]").forEach((button)=>button.setAttribute("aria-pressed",String(button.dataset.activityFilter===activityFilter)));
  el("activity-type-label").textContent=activityTypeLabels[activityType];
  document.querySelectorAll("[data-activity-type]").forEach((option)=>option.setAttribute("aria-selected",String(option.dataset.activityType===activityType)));
  for(const filter of ["all","running","waiting","blocked","failed","done"]){el("filter-"+filter+"-count").textContent=all.filter((item)=>matchesActivityFilter(item,filter,activeKeys.has(item.kind+":"+item.id))).length}
  const active=list(data.activity?.active).filter((item)=>matchesActivityFilter(item,activityFilter,true));
  const recent=list(data.activity?.recent).filter((item)=>matchesActivityFilter(item));
  el("active-activity").innerHTML=active.length?'<div class="stream-label">Running now</div>'+active.map((item)=>storyCard(item,true)).join(""):"";
  const groups=[];
  for(const item of recent){const label=["running","waiting","blocked"].includes(activityFilter)?"Open work":dayLabel(item.occurredAt);const group=groups.at(-1);if(group?.label===label)group.items.push(item);else groups.push({label,items:[item]})}
  const emptyCopy={running:"Nothing is running.",waiting:"Nothing is waiting.",blocked:"Nothing is blocked.",failed:"No failed activity.",done:"No completed activity."}[activityFilter]||"No activity yet.";
  el("activity").innerHTML=groups.length?groups.map((group)=>'<section class="activity-day"><h3>'+esc(group.label)+'</h3>'+group.items.map((item)=>storyCard(item)).join("")+'</section>').join(""):empty(emptyCopy);
  restoreViewAnchor(anchor);
}

function renderHeader(data){
  const environment=String(data.environment||"unknown").toLowerCase();
  el("environment").textContent=environment.toUpperCase();
  el("environment").className="environment "+environment;
  el("revision-text").textContent="revision "+short(data.revision,10);
  const latest=list(data.deployments)[0];
  el("release-tooltip").innerHTML='<div class="tooltip-title">Deployed revision</div><div class="tooltip-copy mono">'+esc(data.revision||"unknown")+'</div>'+(latest?'<div class="tooltip-copy">Verified '+esc(ago(latest.verifiedAt))+'</div>':"");
}

function render(data){
  latestSnapshot=data;
  renderHeader(data);
  if(!activityRoute())document.title="Discord AI Agent · Console";
  const minute=Math.floor(Date.now()/60000);
  renderChanged("system",[data.services,data.producers,data.deployments,data.summary,minute],()=>renderSystem(data));
  renderChanged("activity",[data.activity,minute],()=>renderActivity(data));
  if(el("activity-search").open)renderActivitySearch(el("activity-search-input").value,true);
  revealView("dashboard-view","dashboard-loading");
  selectInitialActivity(data);
}

function updateActivityQuery(){const url=new URL(location.href);url.searchParams.set("filter",activityFilter);if(activityType==="all")url.searchParams.delete("type");else url.searchParams.set("type",activityType);history.replaceState(null,"",url.pathname+url.search+url.hash)}
function setActivityFilter(filter){activityFilter=filter;updateActivityQuery();if(latestSnapshot)renderActivity(latestSnapshot);el("activity-scroll").scrollTo({top:0})}
const typeOptions=()=>[...document.querySelectorAll("[data-activity-type]")];
const openTypeMenu=()=>{el("activity-type-options").hidden=false;el("activity-type-trigger").setAttribute("aria-expanded","true")};
const closeTypeMenu=(restoreFocus=false)=>{el("activity-type-options").hidden=true;el("activity-type-trigger").setAttribute("aria-expanded","false");if(restoreFocus)el("activity-type-trigger").focus()};
const setActivityType=(type)=>{activityType=type;closeTypeMenu();updateActivityQuery();if(latestSnapshot)renderActivity(latestSnapshot);el("activity-scroll").scrollTo({top:0})};
const navigateToActivityPath=(path,focusStory=false)=>{history.pushState(null,"",path);const route=activityRoute();if(!route)return;if(latestSnapshot)renderActivity(latestSnapshot);refreshActivityDetail(route);if(mobileWorkspace())requestAnimationFrame(()=>el("activity-back").focus());else if(focusStory)requestAnimationFrame(()=>{const selected=document.querySelector('a.story[aria-current="true"]');selected?.focus({preventScroll:true});selected?.scrollIntoView({block:"nearest"})})};
const visibleStories=()=>[...document.querySelectorAll("a.story")];
const moveThroughActivity=(delta,open=false)=>{const stories=visibleStories();if(!stories.length)return;const current=stories.findIndex((story)=>story.matches('[aria-current="true"]')||story===document.activeElement);const next=Math.max(0,Math.min(stories.length-1,(current<0?(delta>0?-1:stories.length):current)+delta));const story=stories[next];if(open){if(story.matches('[aria-current="true"]'))return;navigateToActivityPath(story.getAttribute("href"),true)}else{story.focus({preventScroll:true});story.scrollIntoView({block:"nearest"})}};
document.querySelectorAll("[data-activity-filter]").forEach((button)=>button.addEventListener("click",()=>setActivityFilter(button.dataset.activityFilter)));
el("activity-type-trigger").addEventListener("click",()=>el("activity-type-options").hidden?openTypeMenu():closeTypeMenu());
el("activity-type-trigger").addEventListener("keydown",(event)=>{if(!["ArrowDown","ArrowUp"].includes(event.key))return;event.preventDefault();openTypeMenu();const options=typeOptions();const selected=options.findIndex((option)=>option.dataset.activityType===activityType);options[event.key==="ArrowUp"?Math.max(0,selected):Math.min(options.length-1,selected+1)]?.focus()});
el("activity-type-options").addEventListener("keydown",(event)=>{const options=typeOptions();const index=options.indexOf(document.activeElement);if(event.key==="Escape"){event.preventDefault();closeTypeMenu(true);return}if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?options.length-1:event.key==="ArrowDown"?Math.min(options.length-1,index+1):Math.max(0,index-1);options[next]?.focus()});
typeOptions().forEach((option)=>option.addEventListener("click",()=>setActivityType(option.dataset.activityType)));
el("activity-search-input").addEventListener("input",(event)=>renderActivitySearch(event.target.value));
el("activity-search-input").addEventListener("keydown",(event)=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();moveSearchSelection(event.key==="ArrowDown"?1:-1);return}if(event.key==="Enter"){event.preventDefault();const story=searchState.results[searchState.index];if(story){closeActivitySearch();navigateToActivityPath(activityPath(story),true)}}});
el("activity-search-results").addEventListener("click",(event)=>{const target=event.target instanceof Element?event.target.closest("[data-search-index]"):null;if(!target)return;const story=searchState.results[Number(target.dataset.searchIndex)];if(story){closeActivitySearch();navigateToActivityPath(activityPath(story),true)}});
el("activity-search").addEventListener("cancel",(event)=>{event.preventDefault();closeActivitySearch()});
el("activity-search").addEventListener("close",()=>{el("activity-search-input").setAttribute("aria-expanded","false");searchState.restoreFocus?.focus();searchState.restoreFocus=null});
el("activity-search").addEventListener("click",(event)=>{if(event.target===el("activity-search"))closeActivitySearch()});
el("activity-scroll").addEventListener("keydown",(event)=>{const target=event.target instanceof Element?event.target.closest("a.story"):null;if(!target||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();moveThroughActivity(event.key==="ArrowDown"?1:-1,true)}else if(event.key==="Home"||event.key==="End"){event.preventDefault();const stories=visibleStories();const story=stories[event.key==="Home"?0:stories.length-1];story?.focus({preventScroll:true});story?.scrollIntoView({block:"nearest"})}});
document.addEventListener("keydown",(event)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();openActivitySearch();return}if(el("activity-search").open||event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;const target=event.target instanceof Element?event.target:null;if(target?.closest('input,textarea,select,button,[contenteditable="true"],dialog'))return;if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();moveThroughActivity(event.key==="ArrowDown"?1:-1,true);return}if(event.key.toLowerCase()==="j"||event.key.toLowerCase()==="k"){event.preventDefault();moveThroughActivity(event.key.toLowerCase()==="j"?1:-1,true)}});
document.addEventListener("click",(event)=>{const target=event.target instanceof Element?event.target:null;if(!target?.closest("#activity-type-menu"))closeTypeMenu()});
document.addEventListener("click",(event)=>{
  const target=event.target instanceof Element?event.target:null;if(!target)return;
  const traceToggle=target.closest("#trace-toggle");if(traceToggle){traceExpanded=!traceExpanded;const route=activityRoute();if(route&&detailState.data)renderActivityDetail(detailState.data,route);return}
  const back=target.closest("#activity-back");if(back){event.preventDefault();history.pushState(null,"",back.getAttribute("href"));clearActivityDetail();focusActivityList();return}
  const story=target.closest("a.story");if(!story||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();navigateToActivityPath(story.getAttribute("href"));
});
async function refreshSnapshot(){const response=await fetch("/api/snapshot",{cache:"no-store"});if(!response.ok)throw new Error("snapshot unavailable");render(await response.json())}
async function refreshActivityDetail(route){const key=route.kind+":"+route.id;const changing=detailState.key!==key;const preserve=changing&&Boolean(detailState.data);if(changing){detailState={key,data:null,loading:false,error:null};traceExpanded=false}detailState.loading=true;const view=el("activity-detail-view");if(changing){document.body.classList.add("detail-selected");el("activity-back").href="/"+activityQuery()+"#activity-panel";view.setAttribute("aria-busy","true");view.classList.add("is-switching");view.classList.toggle("preserving-detail",preserve);if(!preserve)renderActivityDetail(null,route);if(latestSnapshot)renderActivity(latestSnapshot)}try{const response=await fetch("/api/activity/"+encodeURIComponent(route.kind)+"/"+encodeURIComponent(route.id),{cache:"no-store"});if(!response.ok)throw new Error("activity unavailable");const data=await response.json();if(detailState.key!==key)return;const changed=JSON.stringify(data)!==JSON.stringify(detailState.data);detailState.data=data;detailState.error=null;if(changing||changed)renderActivityDetail(data,route)}catch(error){if(detailState.key===key){detailState.error=error;if(changing)renderActivityDetail(null,route)}}finally{if(detailState.key===key){detailState.loading=false;view.setAttribute("aria-busy","false");if(changing){view.scrollTo({top:0});requestAnimationFrame(()=>{if(detailState.key===key){view.classList.remove("is-switching","preserving-detail")}})}if(latestSnapshot)renderActivity(latestSnapshot)}}}
window.addEventListener("popstate",()=>{const route=activityRoute();if(route){refreshActivityDetail(route);if(mobileWorkspace())requestAnimationFrame(()=>el("activity-back").focus())}else{clearActivityDetail();focusActivityList()}});
async function refresh(){if(refreshInFlight)return refreshInFlight;const route=activityRoute();refreshInFlight=Promise.all([refreshSnapshot(),route?refreshActivityDetail(route):Promise.resolve(clearActivityDetail())]).catch(()=>{el("service-summary").textContent="Services unavailable";el("producer-summary").textContent="Producers unavailable";loadingError("dashboard-loading","Production data unavailable")}).finally(()=>{refreshInFlight=null});return refreshInFlight}
refresh();setInterval(refresh,5000);
`;

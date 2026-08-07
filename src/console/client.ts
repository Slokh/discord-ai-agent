export const dashboardClient = String.raw`
const el=(id)=>document.getElementById(id);
const list=(value)=>Array.isArray(value)?value:[];
const esc=(value)=>String(value??"").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
const ago=(value)=>{if(!value)return "never";const seconds=Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000));if(seconds<5)return "now";if(seconds<60)return seconds+"s ago";const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+"m ago";const hours=Math.floor(minutes/60);if(hours<24)return hours+"h ago";return Math.floor(hours/24)+"d ago"};
const duration=(value)=>{if(!value)return "waiting";const seconds=Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000));if(seconds<60)return seconds+"s";const minutes=Math.floor(seconds/60);return minutes<60?minutes+"m "+seconds%60+"s":Math.floor(minutes/60)+"h "+minutes%60+"m"};
const elapsed=(value)=>{const seconds=Math.max(0,Math.round(Number(value||0)/1000));if(seconds<60)return seconds+"s";const minutes=Math.floor(seconds/60);return minutes<60?minutes+"m "+seconds%60+"s":Math.floor(minutes/60)+"h "+minutes%60+"m"};
const short=(value,length=8)=>value?String(value).slice(0,length):"—";
const badge=(value)=>'<span class="badge '+esc(value)+'">'+esc(String(value).replaceAll("_"," "))+'</span>';
const empty=(copy)=>'<div class="empty">'+esc(copy)+'</div>';
const safeLink=(url,label)=>{if(!url||!/^https:\/\/(github\.com|discord\.com\/channels)\//.test(url))return "";return '<a class="link" target="_blank" rel="noreferrer" href="'+esc(url)+'">'+esc(label)+'</a>'};
const tooltipRow=(name,status,detail)=>'<div class="tooltip-row"><span class="status-dot '+esc(status)+'" aria-hidden="true"></span><span>'+esc(name)+'</span><span>'+esc(String(status).replaceAll("_"," ")+" · "+detail)+'</span></div>';
let latestSnapshot=null;
let detailState={key:null,data:null,loading:false,error:null};
let refreshInFlight=null;
const sectionFingerprints=new Map();
let contextExpanded=false;
const loadingTransitionMs=200;
const requestedFilter=new URLSearchParams(location.search).get("filter");
let activityFilter=["all","active","waiting","blocked","failures","system"].includes(requestedFilter)?requestedFilter:"all";
const activityRoute=()=>{const match=location.pathname.match(/^\/activity\/([^/]+)\/([^/]+)$/);if(!match)return null;try{return {kind:decodeURIComponent(match[1]),id:decodeURIComponent(match[2])}}catch{return null}};
const activityPath=(story)=>"/activity/"+encodeURIComponent(story.kind)+"/"+encodeURIComponent(story.id)+"?filter="+encodeURIComponent(activityFilter);
const renderChanged=(key,value,renderSection)=>{const next=JSON.stringify(value);if(sectionFingerprints.get(key)===next)return;sectionFingerprints.set(key,next);renderSection()};
const revealView=(targetId,loaderId)=>{const target=el(targetId);const loader=el(loaderId);target?.classList.add("is-ready");target?.removeAttribute("inert");target?.setAttribute("aria-busy","false");if(!loader||loader.hidden)return;loader.classList.add("is-complete");loader.setAttribute("aria-hidden","true");setTimeout(()=>{loader.hidden=true},loadingTransitionMs)};
const loadingError=(loaderId,message)=>{const loader=el(loaderId);if(!loader)return;loader.classList.add("error");const status=loader.querySelector(".loading-status");if(status)status.textContent=message;const error=loader.querySelector(".loading-error");if(error)error.hidden=false};

function renderSystem(data){
  const attention=list(data.attention);
  const services=list(data.services);
  const producers=list(data.producers);
  const deployments=list(data.deployments);
  const telemetryAvailable=Boolean(data.summary.serviceTelemetryAvailable);
  const healthyServices=Number(data.summary.healthyServices||0);
  const serviceCount=Number(data.summary.serviceCount||services.length);
  const healthyProducers=producers.filter((item)=>item.status==="succeeded").length;
  const failedProducers=producers.filter((item)=>["failed","blocked","stale","timed_out"].includes(item.status)).length;
  const systemStatus=!telemetryAvailable?"partial":attention.length||failedProducers?"degraded":"healthy";
  el("system-dot").className="status-dot "+systemStatus;
  el("system-label").textContent=systemStatus==="healthy"?"Healthy":systemStatus==="partial"?"Status partial":"Needs attention";
  el("service-summary").textContent=telemetryAvailable?healthyServices+"/"+serviceCount+" services":serviceCount+" services · status unavailable";
  el("producer-summary").textContent=healthyProducers+"/"+producers.length+" producers";
  el("attention-summary").textContent=attention.length+" attention";
  el("attention-segment").className="status-segment"+(attention.length?" alert":"");
  el("attention-segment").setAttribute("aria-pressed",String(activityFilter==="blocked"));

  const kubernetes=data.summary.serviceTelemetrySource==="kubernetes";
  el("services-tooltip").innerHTML='<div class="tooltip-title">'+esc(kubernetes?"Kubernetes readiness":"Live process heartbeats")+'</div>'+services.map((service)=>{
    const unavailable=service.status==="unavailable";
    const detail=unavailable?"not reporting":kubernetes?service.instances+"/"+service.desiredInstances+" ready":service.instances+" live · "+ago(service.lastSeenAt);
    return tooltipRow(service.component,service.status,detail);
  }).join("");

  el("producers-tooltip").innerHTML='<div class="tooltip-title">Proof producers</div>'+producers.map((item)=>tooltipRow(item.trigger.replaceAll("_"," "),item.status,item.outcomeCode||ago(item.completedAt||item.startedAt))).join("")+(deployments.length?'<div class="tooltip-divider"></div><div class="tooltip-title">Latest verified release</div><div class="tooltip-copy mono">'+esc(short(deployments[0].revision,10))+" · "+esc(ago(deployments[0].verifiedAt))+"</div>":"");
  el("attention-tooltip").innerHTML=attention.length?'<div class="tooltip-title">Needs attention</div>'+attention.slice(0,6).map((item)=>'<div class="tooltip-alert"><span class="severity '+esc(item.severity)+'" aria-hidden="true"></span><span><strong>'+esc(item.title)+'</strong><small>'+esc(item.detail)+'</small></span></div>').join(""):'<div class="tooltip-copy">No items need attention.</div>';
}

const activityKind=(value,hasParent=false)=>value==="conversation"?(hasParent?"reply":"prompt"):({code_change:"code change",improvement:"improvement",release:"release",system:"system"}[value]||String(value||"activity").replaceAll("_"," "));
const matchesActivityFilter=(item,filter)=>{const selected=typeof filter==="string"?filter:activityFilter;if(selected==="all")return true;if(selected==="active")return ["active","waiting","blocked"].includes(item.workState);if(selected==="waiting"||selected==="blocked")return item.workState===selected;if(selected==="failures")return item.category==="failure";return item.category==="system"};
const viewAnchor=()=>{const scroll=el("activity-scroll");if(!scroll||scroll.scrollTop<=0)return null;const story=[...scroll.querySelectorAll("[data-story-id]")].find((item)=>item.getBoundingClientRect().bottom>scroll.getBoundingClientRect().top);return story?{id:story.dataset.storyId,top:story.getBoundingClientRect().top}:null};
const restoreViewAnchor=(anchor)=>{if(!anchor)return;const story=document.querySelector('[data-story-id="'+CSS.escape(anchor.id)+'"]');if(story)el("activity-scroll").scrollBy(0,story.getBoundingClientRect().top-anchor.top)};
const lifecycle=(items)=>list(items).length?'<ol class="story-lifecycle" aria-label="Lifecycle">'+list(items).map((step)=>'<li class="'+esc(step.state)+'"><span class="lifecycle-dot" aria-hidden="true"></span><span>'+esc(step.label)+'</span></li>').join("")+'</ol>':"";
const statusBadge=(story,active)=>active||story.kind==="improvement"||["danger","warning"].includes(story.tone)?badge(story.status):"";
const latency=(story)=>Number.isFinite(story.durationMs)?'<span class="story-latency '+esc(story.latencyTone||"normal")+'"><span class="sr-only">Duration </span>'+esc(elapsed(story.durationMs))+'</span>':"";
const redundantOutcome=(story)=>story.tone==="success"&&["Reply delivered","Code change completed","Production rollout verified","Background work completed"].includes(story.summary);
const storyMeta=(story,active)=>{const items=[];const summary=story.summary||String(story.status).replaceAll("_"," ");if(summary&&!redundantOutcome(story))items.push('<span class="story-outcome">'+esc(summary)+'</span>');const state=statusBadge(story,active);if(state)items.push(state);if(active){items.push('<span class="active-now">active</span>');if(story.startedAt)items.push('<span class="story-duration"><span class="sr-only">Running for </span>'+esc(duration(story.startedAt))+'</span>')}else{const timing=latency(story);if(timing)items.push(timing)}if(Number(story.attempts)>1)items.push('<span class="story-attempts">'+esc(story.attempts)+' attempts</span>');if(["thread","dm"].includes(story.responseKind))items.push('<span class="story-delivery">'+esc(story.responseKind)+'</span>');if(story.kind==="code_change"&&story.branchName)items.push('<span class="story-branch mono">'+esc(story.branchName)+'</span>');return items.length?'<span class="story-meta">'+items.join("")+'</span>':""};
const storyCard=(story,active=false)=>{const selected=detailState.key===story.kind+":"+story.id;return '<a class="story '+esc(story.tone)+(active?' active':'')+(selected?' selected':'')+'" data-story-id="'+esc(story.id)+'" href="'+esc(activityPath(story))+'"'+(selected?' aria-current="true"':'')+'><span class="story-summary"><span class="story-mark" aria-hidden="true"></span><span class="story-main"><span class="story-title-row"><span class="story-kind">'+esc(activityKind(story.kind,story.hasParent))+'</span>'+storyMeta(story,active)+'</span><span class="story-detail-row"><span class="story-title">'+esc(story.title)+'</span></span></span><span class="story-trailing">'+(active?'':'<time datetime="'+esc(story.occurredAt)+'">'+esc(ago(story.occurredAt))+'</time>')+'<span class="story-chevron" aria-hidden="true"></span></span></span></a>'};
const dayKey=(value)=>{const date=new Date(value);return date.getFullYear()+"-"+(date.getMonth()+1)+"-"+date.getDate()};
const dayLabel=(value)=>{const today=new Date();const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);const key=dayKey(value);if(key===dayKey(today))return "Today";if(key===dayKey(yesterday))return "Yesterday";return new Intl.DateTimeFormat(undefined,{weekday:"long",month:"short",day:"numeric"}).format(new Date(value))};
const exactTime=(value)=>value?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"medium"}).format(new Date(value)):"—";
const detailMetric=(label,value,tone="")=>value==null||value===""?"":'<div class="detail-metric '+esc(tone)+'"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';
const detailLinks=(story)=>{const links=safeLink(story.sourceUrl,"Open source ↗")+safeLink(story.responseUrl,story.responseKind==="dm"?"Open DM ↗":story.responseKind==="thread"?"Open thread ↗":"Open reply ↗")+safeLink(story.pullRequestUrl,"Open pull request ↗");return links?'<div class="detail-links">'+links+'</div>':""};
const detailRuns=(story)=>{const runs=list(story.runs);if(!runs.length)return "";return '<section class="detail-section"><div class="detail-section-heading"><h2>Runs</h2><span>'+runs.length+'</span></div><div class="detail-run-list">'+runs.map((run)=>'<div class="detail-run"><span class="story-mark '+esc(run.tone)+'" aria-hidden="true"></span><div><strong>'+esc(run.title)+'</strong><span>'+esc(String(run.status).replaceAll("_"," "))+'</span></div>'+(Number.isFinite(run.durationMs)?'<span>'+esc(elapsed(run.durationMs))+'</span>':"")+'<time datetime="'+esc(run.occurredAt)+'">'+esc(exactTime(run.occurredAt))+'</time></div>').join("")+'</div></section>'};
const detailEvents=(story)=>{const events=list(story.technicalEvents);if(!events.length)return "";return '<section class="detail-section"><div class="detail-section-heading"><h2>Technical events</h2><span>'+events.length+'</span></div><div class="detail-event-list">'+events.map((event)=>'<div class="detail-event"><span class="timeline-mark '+esc(event.level)+'" aria-hidden="true"></span><div><strong>'+esc(event.label||event.name)+'</strong><code>'+esc(event.name)+'</code></div><span class="event-level '+esc(event.level)+'">'+esc(event.level)+'</span><time datetime="'+esc(event.createdAt)+'">'+esc(exactTime(event.createdAt))+'</time></div>').join("")+'</div></section>'};
const detailContext=(story)=>{const labels={conversation:"Delivery and execution",code_change:"Repository work",improvement:"Improvement lifecycle",release:"Deployment",system:"Background operations"};return labels[story.kind]||"Activity"};
const discordText=(value)=>String(value??"").split("\n").map((line)=>{const subtext=line.startsWith("-# ");const quote=!subtext&&line.startsWith("> ");let text=esc(line.slice(subtext?3:quote?2:0));text=text.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/&lt;@&amp;(\d+)&gt;/g,'<span class="discord-mention" title="Role $1">@role</span>').replace(/&lt;@!?(\d+)&gt;/g,'<span class="discord-mention" title="User $1">@user</span>');return subtext?'<span class="discord-subtext">'+text+'</span>':quote?'<span class="discord-quote">'+text+'</span>':text}).join("\n");
const formatBytes=(value)=>{const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<=0)return "";if(bytes<1024)return bytes+" B";if(bytes<1048576)return Math.round(bytes/1024)+" KB";return (bytes/1048576).toFixed(1)+" MB"};
const messageLabels=(message)=>[(message.current?"Current prompt":null),(message.reply?"Reply":null),(message.deleted?"Deleted":null)].filter(Boolean).map((label)=>'<span class="message-label '+(label==="Deleted"?'deleted':'')+'">'+label+'</span>').join("");
const messageTime=(message)=>{const time='<time datetime="'+esc(message.createdAt)+'">'+esc(exactTime(message.createdAt))+'</time>';return message.url&&/^https:\/\/discord\.com\/channels\//.test(message.url)?'<a class="message-time-link" target="_blank" rel="noreferrer" href="'+esc(message.url)+'" aria-label="Open message in Discord">'+time+'</a>':time};
const messageAttachments=(message)=>list(message.attachments).length?'<div class="discord-attachments">'+list(message.attachments).map((attachment)=>'<div class="discord-attachment"><span class="attachment-icon" aria-hidden="true">FILE</span><span><strong>'+esc(attachment.filename||"Attachment")+'</strong><small>'+esc([attachment.contentType,formatBytes(attachment.sizeBytes)].filter(Boolean).join(" · "))+'</small></span></div>').join("")+'</div>':"";
const conversationMessage=(message)=>{const unavailable=message.deleted?"Deleted message":"Message content unavailable";const content=message.content?'<div class="conversation-content">'+discordText(message.content)+'</div>':message.unavailable?'<div class="conversation-content unavailable">'+unavailable+'</div>':"";const initial=message.role==="assistant"?"AI":String(message.author||"M").trim().slice(0,1).toUpperCase();return '<article class="conversation-message '+esc(message.role)+(message.current?' current':'')+'"><span class="message-avatar" aria-hidden="true">'+esc(initial)+'</span><div class="message-body"><header><strong>'+esc(message.author||message.role)+'</strong>'+messageLabels(message)+messageTime(message)+'</header>'+content+messageAttachments(message)+'</div></article>'};
const collapsedContextMessages=(messages)=>{const currentIndex=messages.findIndex((message)=>message.current);const fallbackParentIndex=currentIndex>0?currentIndex-1:-1;return messages.filter((message,index)=>message.directParent||index===fallbackParentIndex||message.current||message.reply)};
const visibleContextMessages=(messages)=>contextExpanded?messages:collapsedContextMessages(messages);
const contextCount=(messages)=>{const visible=visibleContextMessages(messages);return visible.length===messages.length?messages.length+" messages":visible.length+" of "+messages.length+" messages"};
const contextToggle=(messages)=>{const earlier=messages.length-collapsedContextMessages(messages).length;if(!earlier)return "";return '<button class="context-history-toggle" id="context-toggle" type="button" aria-expanded="'+String(contextExpanded)+'"><span class="context-toggle-chevron" aria-hidden="true"></span>'+esc((contextExpanded?"Hide ":"Show ")+earlier+" earlier "+(earlier===1?"message":"messages"))+'</button>'};
const contextBody=(story,detail)=>{if(detailState.loading&&!detail)return '<div class="detail-loading">Loading context…</div>';if(detailState.error&&!detail)return '<div class="detail-loading danger">Context unavailable.</div>';const messages=list(detail?.messages);return messages.length?contextToggle(messages)+'<div class="conversation-chain">'+visibleContextMessages(messages).map(conversationMessage).join("")+'</div>':'<div class="detail-loading">No retained context was found.</div>'};
const contextSection=(story,detail)=>story.kind==="conversation"?'<section class="detail-section conversation-section"><div class="detail-section-heading"><h2>Context</h2><span id="conversation-count">'+(detail?contextCount(list(detail.messages)):"—")+'</span></div><div id="conversation-chain">'+contextBody(story,detail)+'</div></section>':"";

function renderActivityDetail(detail,route){
  const story=detail?.story;
  document.body.classList.add("detail-selected");
  el("activity-back").href="/?filter="+encodeURIComponent(activityFilter)+"#activity-panel";
  el("activity-detail-view").setAttribute("aria-busy",String(!story&&!detailState.error));
  if(!story){document.title=(detailState.error?"Activity unavailable":"Loading activity")+" · Console";el("activity-detail").innerHTML='<section class="detail-empty workspace-empty"><span class="terminal-prompt" aria-hidden="true">'+(detailState.error?"!_":"›_")+'</span><h2>'+(detailState.error?"Activity unavailable":"Loading activity…")+'</h2><p>'+(detailState.error?"This item is outside the current activity window or no longer exists.":"Fetching context and execution details.")+'</p></section>';return}
  document.title=story.title+" · Console";
  const active=Boolean(detail.active);
  const metrics=[
    detailMetric("Status",String(story.status).replaceAll("_"," "),story.tone),
    detailMetric(active?"Running":"Occurred",active?duration(story.startedAt):exactTime(story.occurredAt)),
    detailMetric("Duration",active?duration(story.startedAt):Number.isFinite(story.durationMs)?elapsed(story.durationMs):null,story.latencyTone),
    detailMetric("Attempts",story.attempts>1?story.attempts:null),
    detailMetric("Branch",story.branchName),
    detailMetric("Runs",story.runCount),
    detailMetric("Successful",story.successCount),
    detailMetric("Failed",story.failureCount,story.failureCount?"danger":""),
    detailMetric("p95 latency",Number.isFinite(story.p95DurationMs)?elapsed(story.p95DurationMs):null),
  ].join("");
  el("activity-detail").innerHTML='<article class="detail-hero '+esc(story.tone)+'"><div class="detail-eyebrow"><span class="story-mark" aria-hidden="true"></span><span>'+esc(activityKind(story.kind,story.hasParent))+'</span><span>'+esc(detailContext(story))+'</span></div><div class="detail-title-row"><div><h1>'+esc(story.title)+'</h1><p>'+esc(story.summary||String(story.status).replaceAll("_"," "))+'</p></div>'+badge(story.status)+'</div>'+detailLinks(story)+'</article>'+(metrics?'<section class="detail-metrics" aria-label="Activity facts">'+metrics+'</section>':"")+contextSection(story,detail)+(list(story.lifecycle).length?'<section class="detail-section"><div class="detail-section-heading"><h2>Lifecycle</h2><span>'+list(story.lifecycle).length+' steps</span></div>'+lifecycle(story.lifecycle)+'</section>':"")+detailRuns(story)+detailEvents(story);
  el("activity-detail-view").setAttribute("aria-busy","false");
}

function clearActivityDetail(){
  detailState={key:null,data:null,loading:false,error:null};
  contextExpanded=false;
  document.body.classList.remove("detail-selected");
  document.title="Discord AI Agent · Console";
  el("activity-detail-view").setAttribute("aria-busy","false");
  el("activity-detail").innerHTML='<div class="detail-placeholder"><span class="terminal-prompt" aria-hidden="true">›_</span><h2>Select activity</h2><p>Choose an item to inspect its context and execution details.</p></div>';
  if(latestSnapshot)renderActivity(latestSnapshot);
}
const mobileWorkspace=()=>matchMedia("(max-width: 760px)").matches;
const focusActivityList=()=>{if(mobileWorkspace())requestAnimationFrame(()=>el("activity-heading-title").focus())};

function renderActivity(data){
  const anchor=viewAnchor();
  const all=[...new Map([...list(data.activity?.active),...list(data.activity?.recent)].map((item)=>[item.kind+":"+item.id,item])).values()];
  document.querySelectorAll("[data-activity-filter]").forEach((button)=>button.setAttribute("aria-pressed",String(button.dataset.activityFilter===activityFilter)));
  for(const filter of ["all","active","waiting","blocked","failures","system"]){el("filter-"+filter+"-count").textContent=all.filter((item)=>matchesActivityFilter(item,filter)).length}
  const active=list(data.activity?.active).filter(matchesActivityFilter);
  const recent=list(data.activity?.recent).filter(matchesActivityFilter);
  el("active-activity").innerHTML=active.length?'<div class="stream-label">Active now</div>'+active.map((item)=>storyCard(item,true)).join(""):"";
  const groups=[];
  for(const item of recent){const label=["active","waiting","blocked"].includes(activityFilter)?"Open work":dayLabel(item.occurredAt);const group=groups.at(-1);if(group?.label===label)group.items.push(item);else groups.push({label,items:[item]})}
  const emptyCopy={active:"No active work.",waiting:"Nothing is waiting.",blocked:"Nothing is blocked.",failures:"No recent failures.",system:"No recent system activity."}[activityFilter]||"No activity yet.";
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
  el("freshness").textContent="Updated "+ago(data.generatedAt);
  el("connection-dot").className="pulse live";
}

function render(data){
  latestSnapshot=data;
  renderHeader(data);
  if(!activityRoute())document.title="Discord AI Agent · Console";
  const minute=Math.floor(Date.now()/60000);
  renderChanged("system",[data.services,data.producers,data.deployments,data.attention,data.summary,minute],()=>renderSystem(data));
  renderChanged("activity",[data.activity,minute],()=>renderActivity(data));
  revealView("dashboard-view","dashboard-loading");
}

function setActivityFilter(filter,scroll=false){activityFilter=filter;const url=new URL(location.href);url.searchParams.set("filter",filter);history.replaceState(null,"",url.pathname+url.search+(scroll?"#activity-panel":url.hash));if(latestSnapshot){renderActivity(latestSnapshot);renderSystem(latestSnapshot)}if(scroll)el("activity-scroll").scrollTo({top:0})}
document.querySelectorAll("[data-activity-filter]").forEach((button)=>button.addEventListener("click",()=>setActivityFilter(button.dataset.activityFilter)));
el("attention-segment").addEventListener("click",()=>setActivityFilter("blocked",true));
document.addEventListener("click",(event)=>{
  const target=event.target instanceof Element?event.target:null;if(!target)return;
  const toggle=target.closest("#context-toggle");if(toggle){contextExpanded=!contextExpanded;const route=activityRoute();if(route&&detailState.data)renderActivityDetail(detailState.data,route);return}
  const back=target.closest("#activity-back");if(back){event.preventDefault();history.pushState(null,"",back.getAttribute("href"));clearActivityDetail();focusActivityList();return}
  const story=target.closest("a.story");if(!story||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();history.pushState(null,"",story.getAttribute("href"));const route=activityRoute();if(route){if(latestSnapshot)renderActivity(latestSnapshot);refreshActivityDetail(route);if(mobileWorkspace())requestAnimationFrame(()=>el("activity-back").focus())}
});
async function refreshSnapshot(){const response=await fetch("/api/snapshot",{cache:"no-store"});if(!response.ok)throw new Error("snapshot unavailable");render(await response.json())}
async function refreshActivityDetail(route){const key=route.kind+":"+route.id;if(detailState.key!==key){detailState={key,data:null,loading:false,error:null};contextExpanded=false}detailState.loading=true;renderActivityDetail(detailState.data,route);if(latestSnapshot)renderActivity(latestSnapshot);try{const response=await fetch("/api/activity/"+encodeURIComponent(route.kind)+"/"+encodeURIComponent(route.id),{cache:"no-store"});if(!response.ok)throw new Error("activity unavailable");const data=await response.json();if(detailState.key!==key)return;detailState.data=data;detailState.error=null}catch(error){if(detailState.key===key)detailState.error=error}finally{if(detailState.key===key){detailState.loading=false;renderActivityDetail(detailState.data,route);if(latestSnapshot)renderActivity(latestSnapshot)}}}
window.addEventListener("popstate",()=>{const route=activityRoute();if(route){refreshActivityDetail(route);if(mobileWorkspace())requestAnimationFrame(()=>el("activity-back").focus())}else{clearActivityDetail();focusActivityList()}});
async function refresh(){if(refreshInFlight)return refreshInFlight;const route=activityRoute();refreshInFlight=Promise.all([refreshSnapshot(),route?refreshActivityDetail(route):Promise.resolve(clearActivityDetail())]).catch(()=>{el("freshness").textContent="Dashboard unavailable";el("connection-dot").className="pulse error";loadingError("dashboard-loading","Production data unavailable")}).finally(()=>{refreshInFlight=null});return refreshInFlight}
refresh();setInterval(refresh,5000);
`;

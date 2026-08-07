export const dashboardReloadClient = String.raw`
let opened=false;
let interrupted=false;
const reloadEvents=new EventSource("/__dev/reload");
reloadEvents.addEventListener("open",()=>{
  if(opened&&interrupted)window.location.reload();
  opened=true;
  interrupted=false;
});
reloadEvents.addEventListener("error",()=>{if(opened)interrupted=true});
`;

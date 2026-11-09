import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ROOT,RUN,readJson,apiClient} from './collector.mjs';
import {LABEL,supportRoot,launchdPlist} from './install.mjs';

const domain='gui/'+process.getuid();
const command=process.argv[2]||'status';
const credentials=await readJson(path.join(ROOT,'.cloudflare-auth','watch-secrets.json'));
if(!credentials?.ADMIN_TOKEN)throw Error('The existing owner control credential is required.');
const api=apiClient(credentials.ADMIN_TOKEN),installedRoot=supportRoot(os.homedir());

if(command==='prepare'||command==='start'){
 if(process.platform!=='darwin')throw Error('The native service installer is for macOS.');
 const {build}=await import('esbuild');
 const bundle=path.join(ROOT,'native','bundle.mjs');
 await build({entryPoints:[path.join(ROOT,'native','collector.mjs')],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
 let nodeExecutable=process.execPath;
 for(const candidate of ['/opt/homebrew/bin/node','/usr/local/bin/node']){try{await fs.access(candidate,fs.constants.X_OK);nodeExecutable=candidate;break;}catch{}}
 const plist=path.join(ROOT,'native',LABEL+'.plist');
 await fs.writeFile(plist,launchdPlist(installedRoot,nodeExecutable),{mode:0o600});
 execFileSync('/usr/bin/plutil',['-lint',plist],{stdio:'inherit'});
 const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
 const launcher='#!/bin/zsh\nset -e\ncd -- "${0:A:h}"\n'+quote(nodeExecutable)+" native/control.mjs start\nprintf '\\nNative pickup watcher installed. You can close Terminal.\\n'\n";
 await fs.writeFile(path.join(ROOT,'Start_Native_Watch.command'),launcher,{mode:0o700});
 if(command==='start'){
  // The owner runs this once in Terminal. Standard service locations keep the
  // running program outside the protected Documents directory.
  await fs.mkdir(path.join(installedRoot,'native'),{recursive:true,mode:0o700});
  await fs.mkdir(path.join(installedRoot,'.cloudflare-auth'),{recursive:true,mode:0o700});
  await fs.mkdir(path.join(installedRoot,'.native-runtime'),{recursive:true,mode:0o700});
  await fs.copyFile(bundle,path.join(installedRoot,'native','collector.mjs'));
  await fs.chmod(path.join(installedRoot,'native','collector.mjs'),0o600);
  const ownerCredential=path.join(installedRoot,'.cloudflare-auth','watch-secrets.json');
  await fs.writeFile(ownerCredential,JSON.stringify({ADMIN_TOKEN:credentials.ADMIN_TOKEN}),{mode:0o600});await fs.chmod(ownerCredential,0o600);
  const launchAgents=path.join(os.homedir(),'Library','LaunchAgents');await fs.mkdir(launchAgents,{recursive:true});
  const installedPlist=path.join(launchAgents,LABEL+'.plist');await fs.copyFile(plist,installedPlist);await fs.chmod(installedPlist,0o600);
  let running=false;try{execFileSync('/bin/launchctl',['print',domain+'/'+LABEL],{stdio:'ignore'});running=true;}catch{}
  if(!running)execFileSync('/bin/launchctl',['bootstrap',domain,installedPlist],{stdio:'inherit'});
  // Activate only after macOS accepts the job. A failed installation cannot
  // strand the relay in native mode without a registered collector.
  const configuration=await api('/native/activate',{});
  console.log(JSON.stringify({nativeEnabled:configuration.enabled,intervalMs:configuration.intervalMs,notBefore:configuration.notBefore,launchd:domain+'/'+LABEL,autoRestart:true,startsAfterLogin:true}));
 }else console.log(JSON.stringify({prepared:plist,bundle,launcher:path.join(ROOT,'Start_Native_Watch.command'),installed:false}));
}else if(command==='status'){
 const s=await api('/status');const local=await readJson(path.join(installedRoot,'.native-runtime','status.json'))||await readJson(path.join(RUN,'status.json'));
 console.log(JSON.stringify({server:{enabled:s.enabled,mode:s.sourceMode,checks:s.checks,lastAttemptAt:s.lastAttemptAt,lastVerifiedAt:s.lastVerifiedAt,nextCheck:s.nextCheck,sourceHealth:s.sourceHealth,lastError:s.lastError,intervalMs:s.pollIntervalMs,nativeLastSeenAt:s.nativeLastSeenAt,recentChecks:(s.recentChecks||[]).slice(0,10)},local},null,2));
}else throw Error('Use prepare, start or status.');

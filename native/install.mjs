import path from 'node:path';
export const LABEL='com.example.iphone-pickup-watch';
export const supportRoot=home=>path.join(home,'Library','Application Support','iPhonePickupWatch');
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function launchdPlist(root,node){
 const run=path.join(root,'.native-runtime');
 const args=['/usr/bin/caffeinate','-s',node,path.join(root,'native','collector.mjs')];
 return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'+`<key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map(arg=>'<string>'+xml(arg)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(path.join(run,'launchd.out.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(run,'launchd.err.log'))}</string>`+'</dict></plist>\n';
}

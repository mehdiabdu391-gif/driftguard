# Independent ground truth for the upgrade recall check.
# Different implementation from DriftGuard: regex call detection + brace matching for the
# first object argument (top-level keys only), direct JSON lookups in the two snapshots.
import json, os, re, sys, glob
DATA=os.environ.get('DRIFTGUARD_DATA', 'data')
CACHE=os.path.expanduser(os.environ.get('DRIFTGUARD_SPEC_CACHE', '~/.cache/driftguard/specs/stripe__openapi'))
smap=json.load(open(f'{DATA}/sdk-maps/stripe-node.json'))['styles']['client']
idx=json.load(open(f'{DATA}/versions/stripe.json'))
def run_for(label):
    runs=[r for r in idx['versions'] if r['version']==label]
    if not runs:
        names={r['version'] for r in idx['versions'] if r['version'][:10]==label[:10]}
        if len(names)==1: runs=[r for r in idx['versions'] if r['version']==names.pop()]
    return runs[-1] if runs else None
docs={}
def doc(sha):
    p=f'{CACHE}/{sha}.json'
    if not os.path.exists(p):
        import urllib.request
        urllib.request.urlretrieve(f'https://raw.githubusercontent.com/stripe/openapi/{sha}/openapi/spec3.json', p)
    if sha not in docs: docs[sha]=json.load(open(p))
    return docs[sha]
def deref(d,s,seen=()):
    if isinstance(s,dict) and '$ref' in s:
        node=d
        for k in s['$ref'][2:].split('/'): node=node[k]
        return deref(d,node)
    return s
def props(d,s,depth=0):
    s=deref(d,s); out={}; req=set()
    if not isinstance(s,dict) or depth>10: return out,req
    out.update(s.get('properties') or {}); req|=set(s.get('required') or [])
    for k in ('allOf','anyOf','oneOf'):
        for sub in s.get(k) or []:
            o,r=props(d,sub,depth+1); out.update(o); req|=r
    return out,req
def shape(p): return re.sub(r'\{[^}]*\}','{}',p)
def op(d,method,path):
    for p,item in d['paths'].items():
        if shape(p)==shape(path) and method.lower() in item: return item[method.lower()]
    return None
def body(d,o):
    c=((o.get('requestBody') or {}).get('content') or {})
    P={};R=set()
    for m in c.values():
        p,r=props(d,m.get('schema') or {}); P.update(p); R|=r
    for prm in o.get('parameters') or []:
        prm=deref(d,prm)
        if prm.get('in')=='query':
            P[prm['name']]=prm.get('schema'); 
            if prm.get('required'): R.add(prm['name'])
    return P,R
CALL=re.compile(r'\b([A-Za-z_$][\w$]*)\.((?:[a-zA-Z]+\.)+[a-zA-Z]+)\s*\(')
PIN=re.compile(r'apiVersion\s*:\s*[\'"]([^\'"]+)[\'"]')
def first_obj(src,i):
    j=i
    while j<len(src) and src[j] in ' \n\t\r': j+=1
    # skip a leading positional id argument: 'id', var,
    m=re.match(r'([A-Za-z_$][\w$.]*|\'[^\']*\'|"[^"]*"|`[^`]*`)\s*,\s*',src[j:])
    if m and not src[j]=='{': j+=m.end()
    if j>=len(src) or src[j]!='{': return None
    depth=0;k=j;keys=[];complete=True;tok=''
    while k<len(src):
        ch=src[k]
        if ch in '\'"`':
            q=ch;e=k+1
            while e<len(src) and src[e]!=q:
                e+= 2 if src[e]=='\\' else 1
            if depth==1:
                after=src[e+1:e+20].lstrip()
                if after.startswith(':'): keys.append(src[k+1:e])
            k=e+1;continue
        if ch in '{[(': depth+=1
        elif ch in '}])':
            depth-=1
            if depth==0: break
        elif depth==1:
            if src.startswith('...',k): complete=False
            m=re.match(r'([A-Za-z_$][\w$]*)\s*(:|,|\})',src[k:])
            if m and (k==0 or not re.match(r'[\w$.]',src[k-1])):
                prev=src[:k].rstrip()[-1:]
                if prev in '{,':
                    if m.group(2)==':' and not src[k+m.end():].startswith(':'): keys.append(m.group(1))
                    elif m.group(2) in ',}': keys.append(m.group(1))
                k+=len(m.group(1));continue
        k+=1
    body_txt=src[j+1:k]
    flat=body_txt
    for _ in range(20):
        nxt=re.sub(r'\{[^{}]*\}|\[[^\[\]]*\]|\([^()]*\)','0',flat)
        if nxt==flat: break
        flat=nxt
    values={a:b for a,b in re.findall(r'(?:^|,)\s*[\'"]?(\w+)[\'"]?\s*:\s*[\'"]([^\'"]*)[\'"]\s*(?=,|$)',flat.strip())}
    return keys,complete,values
res={}
for repo in sys.argv[1:]:
    root=os.path.join(os.environ.get('REPOS', 'repos'), repo); truth=[]; calls=0
    for f in glob.glob(root+'/**/*.*',recursive=True):
        if 'node_modules' in f or not re.search(r'\.(ts|tsx|js|jsx|mjs|cjs)$',f) or os.path.isdir(f): continue
        src=open(f,errors='ignore').read()
        if 'stripe' not in src.lower(): continue
        pins=PIN.findall(src)
        for m in CALL.finditer(src):
            parts=(m.group(1)+'.'+m.group(2)).split('.')
            chain=next(('.'.join(parts[i:]) for i in range(1,len(parts)-1) if '.'.join(parts[i:]) in smap), None)
            if not chain: continue
            calls+=1
            line=src.count('\n',0,m.start())+1
            rel=os.path.relpath(f,root)
            label=pins[0] if len(set(pins))==1 else None
            if not label: continue
            fr=run_for(label); to=idx['versions'][-1]
            if not fr or fr['last']['sha']==to['last']['sha']: continue
            B=doc(fr['last']['sha']); T=doc(to['last']['sha'])
            meth,path=smap[chain]['method'],smap[chain]['path']
            ob=op(B,meth,path); ot=op(T,meth,path)
            if not ob: continue
            if not ot: truth.append((rel,line,'endpoint-removed',''));continue
            parsed=first_obj(src,m.end())
            if not parsed: continue
            keys,complete,values=parsed
            PB,RB=body(B,ob); PT,RT=body(T,ot)
            for k in keys:
                if k in PB and k not in PT: truth.append((rel,line,'request-field-removed',k))
            def enums(D,sc):
                sc=deref(D,sc or {}); out=set(); free=False
                alts=[sc]+[deref(D,x) for k2 in ('anyOf','oneOf') for x in (sc.get(k2) or [])]
                for a in alts:
                    if 'enum' in a: out|=set(map(str,a['enum']))
                    elif a.get('type') in ('string','integer','number','boolean'): free=True
                return out,free
            for k,v in values.items():
                if k in PB and k in PT:
                    eb,_=enums(B,PB[k]); et,ft=enums(T,PT[k])
                    if v in eb and v not in et and not ft: truth.append((rel,line,'request-enum-value-removed',k))
            if complete:
                for k in RT-RB:
                    if k not in keys: truth.append((rel,line,'request-field-required',k))
    res[repo]={'calls':calls,'truth':truth}
json.dump(res,open(os.environ.get('OUT', 'truth.json'),'w'),indent=1)
for r,v in res.items(): print(r[:45].ljust(46), v['calls'], v['truth'])

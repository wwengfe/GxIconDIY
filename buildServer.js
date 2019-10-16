const Koa = require('koa');
const cors = require('koa2-cors');
const kjson = require('koa-json')
const router = require('koa-router')();
const bodyParser = require('koa-bodyparser');
const JWT = require('jsonwebtoken');
const IO = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const queue = require('queue');
const fsex=require("fs-extra");
const http=require('http');
const log=require('npmlog');
const Git = require('simple-git/promise')();
const uuid=require("uuid/v4");
const pty = require('node-pty');
const static = require('koa-static');

var q = queue();
q.autostart=true;
q.concurrency=1;
q.start();
q.current=false;
q.on("start",function(job){
    q.current=job;
});
q.on("success",function(){
    q.current=false;
});
q.on("error",function(err){
    log.error("JOB",err);
    q.current=false;
});
var finishedJobs=[];
var socketPool={};

const app = new Koa();
app.use(cors());
app.use(kjson());
app.use(bodyParser());
app.use(static(path.join( __dirname,'./buildServerAssets')));
const server = http.Server(app.callback());
const io = IO(server);
var port=process.env.PORT || 5656;
server.listen(port, () => {
    log.info("WEB",`httpd started at ${port}`);
})
router.post('/api/build', async (ctx, next) => {
    var jwt=ctx.request.body.data;
    try {
        var decoded = JWT.verify(jwt, 'gxicon_toki_key');
    } catch(err) {
        ctx.response.body = {
            code:401
        };
        return next();
    }
    var localId=addJob({
        jobId:ctx.request.body.id,
        config:decoded.data
    });
    ctx.response.body = {
        code:0,
        data:{
            localId:localId,
            status:q.current._gx_info.localId==localId?"current":"pending",
            queueLength:q.jobs.length
        }
    }
});
router.get('/api/queue', async (ctx, next) => {
    var infos=[]
    for(var i of q.jobs){
        infos.push(i._gx_info);
    }
    ctx.response.body = {code:0,data:{
        status:q.jobs.length==0?"idle":"busy",
        queue:infos.reverse(),
        current:q.current._gx_info,
        finished:[].concat(finishedJobs).reverse().slice(0,10)
    }};
});
router.get('/', async (ctx, next) => {
    ctx.response.body = 'GxIcon BuildServer [beta]<br>Current pending jobs:<br>';
});
router.get('/terminal', async (ctx, next) => {
    ctx.response.body = 'GxIcon BuildServer [beta]<br>Current pending jobs:<br>';
});
app.use(router.routes());
io.on('connection', function(socket){
    socket.on("register",function(id){
        socket._id=id;
        socket._uniq=uuid();
        socketPool[id]=socketPool[id]||[];
        socketPool[id].push(socket);
        socket.emit("status","connected");
    })
    socket.on('disconnect', function(){
        for(var i in socketPool[socket._id]){
            if(socketPool[socket._id]._uniq==socket._uniq){
                socketPool[socket._id].splice(i,1);
            }
        }
    });
});
function addJob(data){
    return (function(){
        data.localId=uuid();
        data.queueTime=new Date().getTime();
        var f=async function () {
            var data=arguments.callee._gx_info;
            data.execTime=new Date().getTime();
            ioSend(data.localId,"status","prepare");
            await resetEnv(function(text){
                ioSend(data.localId,"message",text);
            });
            ioSend(data.localId,"status","config");
            await fsex.writeFile("_autoMake.json",JSON.stringify(data.config, null, 4));
            ioSend(data.localId,"status","build");
            await execMake(function(text){
                ioSend(data.localId,"message",text);
            });
            ioSend(data.localId,"status","sign");
            ioSend(data.localId,"status","upload");
            data.endTime=new Date().getTime();
            finishedJobs.push(data);
            log.info("JOB","END",{localId:data.localId,jobId:data.jobId});
            ioSend(data.localId,"status","done");
        };
        f._gx_info=data;
        log.info("JOB","ADD",{localId:data.localId,jobId:data.jobId});
        q.push(f);
        return data.localId;
    })(data);
}
async function sleep(usec){
    return new Promise(function(resolve){
        setTimeout(resolve,usec);
    });
}
async function resetEnv(write){
    await ptySpawn('git', ['fetch'],write);
    await ptySpawn('git',['clean','-xdf','-e','node_modules','-e','build/','-e','.gradle'],write);
    await ptySpawn('git',['reset','--hard','HEAD'],write);
}
async function execMake(write){
    await ptySpawn('node',['autoMake'],write);
    await ptySpawn('./gradlew',['assembleRelease'],write);
}
async function ptySpawn(cmd,arg,datawrite){
    return new Promise(function(resolve,reject){
        log.info("CMD",cmd,arg);
        var ptyProcess = pty.spawn(cmd,arg, {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: __dirname,
            env: process.env
        });
        ptyProcess.on('data',function(data){
            datawrite(data);
        });
        ptyProcess.on('exit',resolve);
    });
}
function ioSend(id,ev,content){
    if(typeof(socketPool[id])=="undefined")return;
    for(var i in socketPool[id]){
        socketPool[id][i].emit(ev,content);
    }
}
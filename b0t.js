#!/usr/bin/env node

//require ALL OF THE THINGS
config   = require('./config.json'),
pkg      = require('./package.json'),
irc      = require('irc'),
c        = require('irc-colors'),
mLog4js  = require('log4js'),
request  = require('request'),
fs       = require('fs');

commands = {},
command_by_plugin = {},
names = {}; // { channel : { nick: rank }}

var get_plugins = function(complete) {

    var error = function(err){
        log.error('Error getting plugins', err);
    }

    var plugin_dir = __dirname + '/plugins/';

    fs.readdir(plugin_dir, function(err, filenames) {
        if (err) {
            error(err); 
            return;
        }

        filenames.forEach(function(filename) {
            
            if(filename.indexOf('.') === 0) return;

            var Plugin = require(plugin_dir + filename + '/cmds.js');
            var info = Plugin.info
            var cmds = Plugin.cmds;

            for(var cmd in cmds){

                if(command_by_plugin[cmd] && command_by_plugin[cmd] !== info.name){
                    log.error('Duplicate command name error, plugin ' + info.name + ' contains a command by the same name! Overwriting command.' )
                }

                command_by_plugin[cmd] = info.name;
                commands[info.name] = commands[info.name] || {info: info, cmds: {}};
                commands[info.name].cmds[cmd] = cmds[cmd];
            }

            log.debug('Loaded Plugin', info.name) 
        });

        complete();
    });
}

var setup_bot = function(){

    var bot = new irc.Client(config.network_name, config.bot_nick, {
        debug: config.debug,
        channels: config.channels
    });

    ACT        = require(__dirname + '/lib/action.js').ACT,
    action     = new ACT(),
    action.bot = bot

    bot.addListener('error', function(message) {
        log.error('ERROR: %s: %s', message.command, message.args.join(' '));
    });

    bot.addListener('registered', function(message) {
        if(config.reg_password) bot.say('NickServ', 'identify ' + config.reg_password);
        if(config.op_password) bot.send('oper', config.bot_nick, config.op_password);
    });

    bot.addListener('join', function(chan, nick, message) {
        log.debug('JOIN', chan, nick);

        action.send_tell_messages(nick);

        if (nick === config.bot_nick) {
            if(config.speak_on_channel_join){
                var enter_msg = config.speak_on_channel_join.split('|');
                if(enter_msg.length > 1 && enter_msg[0].toLowerCase() === 'qotd'){
                    action.get_db_data('/topic', function(data){
                        if(data.length > 0){
                            action.say(c.green(data[Math.floor(Math.random()*data.length)]), 1, {to: chan, skip_verify: true, ignore_bot_speak: true});
                        } else {
                            action.say(c.green(enter_msg[1]), 1, {to: chan, skip_verify: true, ignore_bot_speak: true});
                        }
                    });
                } else {
                    action.say(config.speak_on_channel_join, 1, {to: chan, skip_verify: true, ignore_bot_speak: true});
                }
            }
            bot.send('samode', chan, '+a', config.bot_nick);
        } else {
            action.get_user_data(nick, {
                label: 'tag',
                col: 'tag',
                ignore_err: true
            }, function(tag){
                if(tag !== false){
                    action.say(tag, 1, {to: chan, skip_verify: true, ignore_bot_speak: true});
                }
            }, true);
        }
        bot.send('names', chan);
    });

    bot.addListener('names', function(chan, nicks) {
        names[chan] = nicks;

        for(var nick in nicks){
            if (nick === config.owner && nicks[nick] !== '~') {
                bot.send('samode', chan, '+q', config.owner);
            } else if(nicks[nick] === ''){
                if(config.voice_users_on_join) bot.send('samode', chan, '+v', nick);
            }
        }
    });

    bot.addListener('+mode', function(chan, by, mode, argument, message)  {
        bot.send('names', chan);
    });

    var verify_command = function(command, command_args, callback) {
        
        var command_data = action.get_command(command);

        if(command_data.err){
            log.error(command_data.err);
            return;
        }
        
        var cmd = action.verify_command(command_data.category, command, true);
        if(cmd === false) return;

        //remove blank commands
        var command_args = command_args.filter(function(value) {
          var val = value.replace(/^\s+|\s+$/g, '');
          return val !== '';
        })

        var required_commands = 0;
        for(var i = 0; i < command_data.params.length; i++) {
            if (command_data.params[i].indexOf('*') !== 0) required_commands++;
        }

        if (command_args.length < required_commands) {
           action.say(cmd, 2, {skip_verify: true});
        } else {
            callback(command_data, command_args, cmd);
        }
    };


    bot.addListener('message', function(nick, chan, text, message) {

        if(nick === config.bot_nick && chan === config.bot_nick) return;
        chan = message.args[0] === config.bot_nick ? nick : chan;

        action.chan = chan;
        action.nick = nick;

        if(chan === nick && config.send_owner_bot_pms && nick !== config.owner){
            var pm = nick + ': ' + text; 
            action.say(pm, 3, { skip_verify: true, to: config.owner, ignore_bot_speak: true });
        } 

        action.send_tell_messages(nick);

        //parse urls
        var links = text.match(/(\b(https?|http):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig);
        if(links && links.length && links.length > 0 && config.parse_links)
        {
            for(var i = 0; i < links.length; i++) {
                action.get_url(links[i], 'sup', function(data){
                    action.say(data, 1, {ignore_bot_speak: true});
                }); 
            }

        //say the bots name
        } else if (text.indexOf(config.bot_nick) > -1) { 
            var command_args_org = text.split(' ');
            command_args_org.shift();

            var say_my_name = '';
            if(command_args_org[0] == '-version') {
                say_my_name = 'verson: ' + pkg.version;
            } else if(command_args_org[0] == '-owner') {
                say_my_name = 'owner: ' + c.rainbow(config.owner);
            } else if(command_args_org[0] === '-link') {
                say_my_name = 'link: https://github.com/z0mbieparade/b0t';
            } else {
                say_my_name = 'for more info try ' + c.teal(config.bot_nick) + ' -version|-owner|-link';
            }   

            action.say(say_my_name, 2, {ignore_bot_speak: true});

        //respond to command
        } else if (text.indexOf(config.command_prefix) === 0) {
            
            var command_args_org = text.split(' ');
            var command = command_args_org[0].slice(1);
            command_args_org.shift();

            verify_command(command, command_args_org, function(command_data, command_args, usage){
                if(command_args[0] === 'help'){
                    action.say(usage, 2, {skip_verify: true});
                    return;
                }
               
                action.is_cmd = true;
                command_data.func(action, nick, chan, command_args, command_args_org.join(' '));

            });

        //everything else
        } else {

            //this is a message in the chan, and we're limiting bot chan speak to only when not busy
            //so we need to log when messages are sent
            if(message.args[0] !== config.bot_nick){
                action.update_chan_speak('chan');
            }
        }
    });
} 

var init = function(){
    mLog4js.loadAppender('file');
    mLog4js.addAppender(mLog4js.appenders.file(__dirname + '/logs/' + config.bot_nick + '.log'));
    if (config.debug) { mLog4js.replaceConsole(); }
    global.log = mLog4js.getLogger('logfile');
    log.setLevel('ALL');
    log.debug("------------------------------------------------------------");
    log.debug("Initializing...");

    get_plugins(function(){
        setup_bot();
    });
}
init(); 

var debug       = require('debug')('amqp10-app'),
    builder     = require('buffer-builder'),
    fs          = require('fs'),

    constants   = require('./lib/constants'),
    exceptions  = require('./lib/exceptions'),
    u           = require('./lib/utilities'),

    AMQPError   = require('./lib/types/amqp_error'),
    Symbol      = require('./lib/types/symbol'),
    Source      = require('./lib/types/source_target').Source,
    Target      = require('./lib/types/source_target').Target,
    M           = require('./lib/types/message'),

    Connection  = require('./lib/connection'),
    Session     = require('./lib/session').Session,
    Link        = require('./lib/session').Link,
    Sasl        = require('./lib/sasl'),

    AMQPClient      = require('./amqp_client');


var partitionAcrossSessions = false;

// @todo A lot of these should be replaced with default policy settings
// @todo amqp_client should be doing a lot of this work
function makeSessions(protocol, port, sbHost, sasName, sasKey, sendAddr, recvAddr, numPartitions, cb) {
    var conn = new Connection({
        containerId: 'test',
        hostname: sbHost,
        idleTimeout: 120000,
        sslOptions: {
        }
    });
    conn.open({
        protocol: protocol,
        host: sbHost,
        port: port,
        user: sasName,
        pass: sasKey
    }, new Sasl());
    conn.on(Connection.Connected, function() {
        var session, boundCB;
        if (partitionAcrossSessions) {
            for (var idx = 0; idx <= numPartitions / 2; ++idx) {
                session = new Session(conn);
                boundCB = cb.bind(null, sendAddr, recvAddr, idx === 0, (idx - 1) * 2, (idx - 1) * 2 + 2);
                session.on(Session.Mapped, boundCB);
                session.on(Session.ErrorReceived, console.log);
                session.begin({
                    nextOutgoingId: 1,
                    incomingWindow: 100,
                    outgoingWindow: 100
                });
            }
        } else {
            session = new Session(conn);
            boundCB = cb.bind(null, sendAddr, recvAddr, false, 0, numPartitions);
            session.on(Session.Mapped, boundCB);
            session.on(Session.ErrorReceived, console.log);
            session.begin({
                nextOutgoingId: 1,
                incomingWindow: 100,
                outgoingWindow: 100
            });
        }
    });
    conn.on(Connection.Disconnected, function() {
        console.log('Disconnected');
    });
}

function makeSender(session, sendAddr, cb) {
    session.on(Session.LinkAttached, function(link) {
        debug('Sender Attached ' + link.name);
        cb(link);
    });
    session.attachLink({
        name: sendAddr,
        role: constants.linkRole.sender,
        source: new Source({
            address: 'localhost'
        }),
        target: new Target({
            address: sendAddr
        }),
        senderSettleMode: constants.senderSettleMode.settled,
        receiverSettleMode: constants.receiverSettleMode.autoSettle,
        maxMessageSize: 10000,
        initialDeliveryCount: 1
    });
}

function makeReceiver(session, recvAddr, cb) {
    session.on(Session.LinkAttached, function (link) {
        if (link.name === recvAddr) {
            var msg = 'Receiver Attached ' + link.name;
            debug(msg);
            cb(link);
        }
    });
    debug('Attaching Receiver ' + recvAddr);
    session.attachLink({
        name: recvAddr,
        role: constants.linkRole.receiver,
        source: new Source({
            address: recvAddr
        }),
        target: new Target({
            address: 'localhost'
        }),
        senderSettleMode: constants.senderSettleMode.settled,
        receiverSettleMode: constants.receiverSettleMode.autoSettle,
        maxMessageSize: 10000,
        initialDeliveryCount: 1
    });
}

var msgId = 1;
var doneSending = false;

function send(link) {
    var timer = setInterval(function() {
        if (link.linkCredit > 0) {
            var curId = msgId++;
            var msg = new M.Message();
            msg.body.push('test message ' + curId);
            link.session.sendMessage(link, msg, {deliveryTag: new Buffer([curId])});
        }
        if (msgId > 100) {
            clearInterval(timer);
            doneSending = true;
        }
    }, 1000);
}

function recv(link) {
    link.on(Link.MessageReceived, function(m) {
        console.log('Message on ' + link.name);
        console.log(m.annotations);
        console.log(m.body);
    });
    setInterval(function() {
        if (link.linkCredit < 5) {
            link.addCredits(10);
        }
    }, 1000);
}

function runSendRecv(sendAddr, recvAddr, doSend, recvStart, recvEnd, session) {
    if (doSend) {
        console.log('Tx to '+sendAddr);
        makeSender(session, sendAddr, send);
    } else {
        var makeRx = function (addr) {
            makeReceiver(session, addr, recv);
        };
        for (var idx = recvStart; idx < recvEnd; ++idx) {
            var curAddr = recvAddr + idx;
            console.log('Rx from ' + curAddr);
            makeRx(curAddr);
        }
    }
}

// From SAS endpoint entry for both send/receive permissions, e.g.:
// Endpoint=sb://<sb-host>/;SharedAccessKeyName=<name>;SharedAccessKey=<key>
// Settings file should be JSON containing:
// {
//   serviceBusHost: <sb-host>,
//   eventHubName: <eh-name>,
//   SASKeyName: <name>,
//   SASKey: <key>
// }

//makeSession(runSendRecv);

if (process.argv.length < 3) {
    console.warn('Usage: node '+process.argv[1]+' <settings json file>');
} else {
    var settingsFile = process.argv[2];
    var settings = require('./' + settingsFile);
    exceptions.assertArguments(settings, [ 'serviceBusHost', 'SASKeyName', 'SASKey', 'eventHubName']);
    var protocol = settings.protocol || 'amqps';
    var port = settings.port || (protocol === 'amqps' ? 5671 : 5672);
    var sbHost = settings.serviceBusHost + '.servicebus.windows.net';
    if (settings.serviceBusHost.indexOf(".") !== -1) {
        sbHost = settings.serviceBusHost;
    }
    var sasName = settings.SASKeyName;
    var sasKey = settings.SASKey;
    var sendAddr = settings.eventHubName;
    var recvAddr = settings.eventHubName + '/ConsumerGroups/' + (settings.consumerGroup || '$default') + '/Partitions/';
    var numPartitions = settings.partitions;
    console.log(sbHost+': '+sendAddr+' - '+recvAddr+' '+numPartitions);
    makeSessions(protocol, port, sbHost, sasName, sasKey, sendAddr, recvAddr, numPartitions, runSendRecv);
}
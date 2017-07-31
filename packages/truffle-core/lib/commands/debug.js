var command = {
  command: 'debug',
  description: 'Interactively debug any transaction on the blockchain (experimental)',
  builder: {
    _: {
      type: "string"
    }
  },
  run: function (options, done) {
    var Config = require("truffle-config");
    var Debugger = require("truffle-debugger");
    var Environment = require("../environment");
    var repl = require("repl");
    var OS = require("os");

    var config = Config.detect(options);

    Environment.detect(config, function(err) {
      if (err) return done(err);

      if (config._.length == 0) {
        return done(new Error("Please specify a transaction hash as the first parameter in order to debug that transaction. i.e., truffle debug 0x1234..."));
      }

      var tx_hash = config._[0];

      var bugger = new Debugger(config);
      var lastCommand = "o";

      var commandReference = {
        "o": "step over",
        "i": "step into",
        "u": "step out",
        "n": "step next",
        ";": "step instruction",
        "p": "print instruction/stack",
        "h": "print this help",
        "q": "quit"
      }

      function commandName(commandId) {
        return "(" + commandId + ") " + commandReference[commandId];
      };

      bugger.start(tx_hash, function(err) {
        if (err) return done(err);

        var help = "Commands:"
          + OS.EOL + "(enter) last command entered (" + commandReference[lastCommand] + ")"
          + OS.EOL + commandName("o") + ", " + commandName("i") + ", " + commandName("u") + ", " + commandName("n") + ", " + commandName(";")
          + OS.EOL + commandName("p") + ", " + commandName("h") + ", " + commandName("q");

        config.logger.log(help);
        config.logger.log("");

        function printLines(lineIndex, totalLines) {
          var source = bugger.getCurrentSource();
          var lines = source.split(OS.EOL)

          var startingLine = Math.max(lineIndex - totalLines + 1, 0);

          // Calculate prefix length
          var maxLineNumberLength = 0;
          for (var i = startingLine; i <= lineIndex; i++) {
            var lineNumber = i + 1;
            maxLineNumberLength = Math.max(maxLineNumberLength, (lineNumber + "").length);
          }

          // Now print the lines
          for (var i = startingLine; i <= lineIndex; i++) {
            var lineNumber = i + 1;
            var line = lineNumber;

            while (line.length < maxLineNumberLength) {
              line = " " + line;
            }

            line += ": ";
            line += lines[i].replace(/\t/g, "  ")

            config.logger.log(line);
          }

          // Include colon and extra space.
          return maxLineNumberLength + 2;
        }

        function printState(started) {
          config.logger.log("");

          var range = bugger.currentInstruction().range;
          var source = bugger.getCurrentSource();
          var lines = source.split(OS.EOL)

          var prefixLength = printLines(range.start.line, 3);

          var line = lines[range.start.line];

          var pointer = "";

          var column = 0;

          for (; column < range.start.column; column++) {
            if (line[column] == "\t") {
              pointer += "  ";
            } else {
              pointer += " ";
            }
          }

          pointer += "^";
          column += 1;

          var end_column = range.end.column;

          if (range.end.line != range.start.line) {
            end_column = line.length - 1;
          }

          for (; column < end_column; column++) {
            pointer += "^";
          }

          for (var i = 0; i < prefixLength; i++) {
            pointer = " " + pointer;
          }

          config.logger.log(pointer);
        }

        function printInstruction(instruction) {
          var step = bugger.getStep();

          var stack = step.stack.map(function(item) {
            return "  " + item;
          });

          if (stack.length == 0) {
            stack.push("  No data on stack.");
          }

          config.logger.log("");
          config.logger.log("(" + bugger.traceIndex + ") " + instruction.name + " " + (instruction.pushData || ""));
          config.logger.log(stack.join(OS.EOL));
          //config.logger.log(JSON.stringify(bugger.currentInstruction, null, 2));
        };

        printState();

        var cli = repl.start({
          prompt: "debug(" + config.network + ":" + tx_hash.substring(0, 10) + "...)> ",
          eval: function(cmd, context, filename, callback) {
            cmd = cmd.trim();

            if (cmd == ".exit") {
              cmd = "q";
            }

            if (cmd.length > 0) {
              cmd = cmd[0];
            }

            if (cmd == "") {
              cmd = lastCommand;
            }

            // Perform commands that require state changes.
            switch (cmd) {
              case "o":
                bugger.stepOver();
                break;
              case "i":
                bugger.stepInto();
                break;
              case "u":
                bugger.stepOut();
                break;
              case "n":
                bugger.step();
                break;
              case ";":
                bugger.stepInstruction();
                break;
              case "q":
                process.exit();
                break;
            }

            // Check if execution has stopped.
            if (bugger.isStopped()) {
              config.logger.log("");
              config.logger.log("Execution stopped.");
              process.exit();
            }

            // Perform post printing
            // (we want to see if execution stopped before printing state).
            switch (cmd) {
              case ";":
              case "p":
                printInstruction(bugger.currentInstruction());
              case "o":
              case "i":
              case "u":
              case "n":
                printState();
                break;
              default:
                config.logger.log("")
                config.logger.log(help);
                config.logger.log("")
            }

            if (cmd != "h" && cmd != "p") {
              lastCommand = cmd;
            }

            callback();
          }
        });

      });
    });
  }
}

module.exports = command;

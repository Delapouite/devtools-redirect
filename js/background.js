/* global chrome, DevtoolsRedirect */
(function() {
  var listeners = [];
  var resourcesRedirected = {};
  var opts = {};
  var refreshOptions = function() {
    //Make sure we remove the old listeners to avoid redirect conflicts,
    listeners.forEach(function(listener) {
      chrome.webRequest.onBeforeRequest.removeListener(listener);
    });

    listeners.length = 0;

    DevtoolsRedirect.getOptions(['rules']).then(function(storeOptions) {
      opts = storeOptions;
      if(opts.rules && opts.rules.length) generateResourceCatchers(opts.rules);
    });
  };

  var setBrowserIcon = function(active, tabId) {
    chrome.browserAction.setIcon({
      path: 'images/browser-icon-' + (active ? 'active' : 'inactive') + '.png',
      tabId: tabId
    });
  };

  // Our hash
  var currentTabId = -1;
  // Set the ID of the current active tab
  chrome.tabs.onActivated.addListener(function(activeInfo) {
    currentTabId = activeInfo.tabId;
  });

  var badgeCounts = {};
  var resetBadgeCount = function(tabId) {
    badgeCounts[tabId] = 0;
  };

  var renderBadgeCount = function(tabId) {
    if(badgeCounts[tabId] > 0) {
      setBrowserIcon(true, tabId);
      chrome.browserAction.setBadgeText({text: badgeCounts[tabId].toString(), tabId: tabId});
    } else {
      setBrowserIcon(false, tabId);
      chrome.browserAction.setBadgeText({text: '', tabId: tabId});
    }
  };

  //Communication,
  var ports = {};
  chrome.extension.onConnect.addListener(function(port) {
      if(port.name !== 'devtools' && port.name !== 'popup' && port.name !== 'panel') return;
      var tabId = port.sender && port.sender.tab.id ? port.sender.tab.id : null;
      ports[port.portId_] = {port: port, portId: port.portId_, tabId: tabId, name: port.name};

      // Remove port when destroyed (eg when devtools instance is closed)
      port.onDisconnect.addListener(function(port) {
        var portObj = ports[port.portId_];
        if(portObj && port.name === 'devtools' && portObj.tabId) disableTab(portObj.tabId);
        delete ports[port.portId_];
      });

      port.onMessage.addListener(function(msg) {
        // Whatever you wish
        if(msg && msg.action) {
          switch(msg.action) {
            case 'refreshOptions':
              refreshOptions();
            break;
            case 'enableTab':
              enableTab(msg.tabId);
            break;
            case 'disableTab':
              disableTab(msg.tabId);
            break;
            case 'getPopupHTML':
              getPopupHTML(msg.tabId);
            break;
            case 'validateUrl':
              validateUrl(msg.id, msg.url);
            break;
          }
        }
      });
  });

  // destination = devtools, popup or panel
  function notify(destination, msg) {
    Object.keys(ports).forEach(function(portId_) {
      if(ports[portId_].name === destination) ports[portId_].port.postMessage(msg);
    });
  }

  var getPopupHTML = function(tabId) {
    var popupHTML = generatePopupHTML(tabId);
    notify('popup', {action: 'updateHTML', tabId: tabId, html: popupHTML});
  };

  var generatePopupHTML = function(tabId) {
    if(resourcesRedirected[tabId]) {
      var newHTML = '';
      $.each(resourcesRedirected[tabId], function(i, r) {
        newHTML += '<li><a href="'+r.resourceURL+'" title="'+r.resourceURL+'" target="_blank">'+truncateURL(r.resourceURL)+'</a> <i class="icon-arrow-right"></i> <a href="'+r.resourceRedirectURL+'" title="'+r.resourceRedirectURL+'" target="_blank">'+truncateURL(r.resourceRedirectURL)+'</a></li>';
      });
      return newHTML;
    }
  };

  var truncateURL = function(url) {
    var str = url;
    if(str.length > 40) str = url.substr(0, 20)+'...'+url.substr(url.length-20, url.length);
    return str;
  };

  var activeTabs = {};
  window.activeTabs = activeTabs;
  var enableTab = function(tabId) {
    activeTabs[tabId] = true;
  };

  var disableTab = function(tabId) {
    delete activeTabs[tabId];
  };

  var validateUrl = function(id, url) {
    //Make an ajax call and make sure it returns a 200 status,
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function() {
      if(xhr.readyState === 4) {
        notify('panel', {action: 'validatedUrl', id: id, url: url, status: xhr.status, content: xhr.status === 200 ? xhr.responseText : null});
      }
    }; // Implemented elsewhere.
    xhr.open('GET', url, true);
    xhr.send();
  };

  //Reset the icon on loading,
  chrome.tabs.onUpdated.addListener(function(updateTabId, changeInfo) {
    if(!activeTabs[updateTabId]) return;

    if(changeInfo.status === 'loading') {
      setBrowserIcon(false, updateTabId);
      resetBadgeCount(updateTabId);
      resourcesRedirected[updateTabId] = [];
      getPopupHTML(updateTabId);
    } else if(changeInfo.status === 'complete') {
      renderBadgeCount(updateTabId);
      //Update popup's content to list active redirects
      getPopupHTML(updateTabId);
    }
  });

  //Get options on init,
  refreshOptions();

  var isResourcePath = function(r) {
    return r[r.length] === '*';
  };

  var getFileName = function(u) {
    var a = document.createElement('a');
    a.href = u;
    return a.pathname.split('/').pop(); // filename.php
  };

  /*
    Build events for the domains,
    Note:
    We're divising it by domains in case there's a lot of domains,
    to not loose speed because we need to check on every resources for every domains at the same time.
  */
  function generateResourceCatchers(rules) {
    $.each(rules, function() {
      var rule = this;

      if(!rule.enabled) return; //Make sure the domain is enabled,
      chrome.webRequest.onBeforeRequest.addListener(listeners[listeners.length] = function(details) {
        //Make sure that the devtools for this tab is active,
        if(!activeTabs[details.tabId]) return;
        for(var i=0; i<rule.resources.length; i++) {
          //Make sure the rule is enabled,
          if(!rule.resources[i].enabled) return;

          var isPath = isResourcePath(rule.resources[i].resourceURL);
          var fileName = getFileName(details.url);
          var regexPath = rule.resources[i].resourceURL.replace('*', '');
          regexPath = regexPath.replace(/\//g, '\\/');
          var regex = new RegExp(regexPath + fileName + '$', 'g');
          var redirectUrl = null;

          //If it's a path redirect if the file is in this path,
          if(regex.test(details.url)) {
            redirectUrl = rule.resources[i].resourceRedirectURL.replace('*', '') + fileName;
          } else if(details.url.indexOf(rule.resources[i].resourceURL) !== -1) {
            redirectUrl = rule.resources[i].resourceRedirectURL;
            if(details.tabId) {
              badgeCounts[details.tabId] = badgeCounts[details.tabId] + 1;
              if(typeof resourcesRedirected[details.tabId] === 'undefined') {
                resourcesRedirected[details.tabId] = [];
              }
              resourcesRedirected[details.tabId].push(rule.resources[i]);
            }
          }

          if(redirectUrl) return {redirectUrl: redirectUrl};
        }
      },
      {
          urls: [
            //Matching only specific type of files,
            rule.domainURL+"*.js*",
            rule.domainURL+"*.jpg*",
            rule.domainURL+"*.jpeg*",
            rule.domainURL+"*.png*",
            rule.domainURL+"*.gif*",
            rule.domainURL+"*.ico*",
            rule.domainURL+"*.svg*",
            rule.domainURL+"*.css*",
            rule.domainURL+"*.less*"
          ]
      },
      ['blocking']
      );
    });
  }

})();
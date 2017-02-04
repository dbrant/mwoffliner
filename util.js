"use strict";

function randomString( len ) {
    let randomString = '';
    let charSet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < len; i++) {
        let randomPoz = Math.floor(Math.random() * charSet.length);
        randomString += charSet.substring(randomPoz, randomPoz + 1);
    }
    return randomString;
}

function deleteNode( node ) {
    if (node.parentNode) {
        node.parentNode.removeChild(node);
    } else {
        node.outerHTML = '';
    }
    node = undefined;
}

function getNextSiblingElement( node ) {
    let sibling = node.nextSibling;
    while (sibling && sibling.nodeType != 1 /* ELEMENT_NODE */) {
        sibling = sibling.nextSibling;
    }
    return sibling;
}

function concatenateToAttribute( old, add ) {
    return old ? old + ' ' + add : add;
}

function lcFirst( str ) {
    str += '';
    let f = str.charAt(0).toLowerCase();
    return f + str.substr(1);
}

function ucFirst( str ) {
    str += '';
    let f = str.charAt(0).toUpperCase();
    return f + str.substr(1);
}

function myDecodeURIComponent( uri ) {
    try {
        return decodeURIComponent(uri);
    } catch (error) {
        console.error(error);
        return uri;
    }
}

function charAt( str, idx ) {
    let ret = '';
    str += '';
    let end = str.length;

    let surrogatePairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    while (( surrogatePairs.exec(str) ) != null) {
        let li = surrogatePairs.lastIndex;
        if (li - 2 < idx) {
            idx++;
        } else {
            break;
        }
    }

    if (idx >= end || idx < 0) {
        return '';
    }

    ret += str.charAt(idx);

    if (/[\uD800-\uDBFF]/.test(ret) && /[\uDC00-\uDFFF]/.test(str.charAt(idx + 1))) {
        ret += str.charAt(idx + 1);
    }

    return ret;
}

function validateEmail( email ) {
    let emailRegex = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return emailRegex.test(email);
}

module.exports = {
    randomString,
    deleteNode,
    getNextSiblingElement,
    concatenateToAttribute,
    lcFirst,
    ucFirst,
    myDecodeURIComponent,
    charAt,
    validateEmail
};
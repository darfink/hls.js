import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { State } from '../../../src/controller/base-stream-controller';
import { FragmentTracker } from '../../../src/controller/fragment-tracker';
import { SubtitleStreamController } from '../../../src/controller/subtitle-stream-controller';
import Decrypter from '../../../src/crypt/decrypter';
import { ErrorDetails } from '../../../src/errors';
import { Events } from '../../../src/events';
import Hls from '../../../src/hls';
import { Fragment, Part } from '../../../src/loader/fragment';
import KeyLoader from '../../../src/loader/key-loader';
import { PlaylistLevelType } from '../../../src/types/loader';
import { AttrList } from '../../../src/utils/attr-list';

use(sinonChai);

const mediaMock = {
  currentTime: 0,
  addEventListener() {},
  removeEventListener() {},
};

const tracksMock = [
  {
    id: 0,
    details: { url: '', fragments: [] },
    attrs: new AttrList({}),
  },
  {
    id: 1,
    attrs: new AttrList({}),
  },
];

describe('SubtitleStreamController', function () {
  let hls;
  let fragmentTracker;
  let keyLoader;
  let subtitleStreamController;

  beforeEach(function () {
    hls = new Hls({});
    mediaMock.currentTime = 0;
    fragmentTracker = new FragmentTracker(hls);
    keyLoader = new KeyLoader(hls.config, hls.logger);

    subtitleStreamController = new SubtitleStreamController(
      hls,
      fragmentTracker,
      keyLoader,
    );

    subtitleStreamController.onMediaAttached(Events.MEDIA_ATTACHED, {
      media: mediaMock,
    });
    subtitleStreamController.state = State.IDLE;
  });

  afterEach(function () {
    subtitleStreamController.onMediaDetaching(Events.MEDIA_DETACHING, {
      media: mediaMock,
    });
    hls.destroy();
  });

  describe('onSubtitleTracksUpdate', function () {
    beforeEach(function () {
      hls.trigger(Events.SUBTITLE_TRACKS_UPDATED, {
        subtitleTracks: tracksMock,
      });
    });

    it('should update tracks list', function () {
      expect(subtitleStreamController.levels).to.have.lengthOf(2);
      expect(subtitleStreamController.levels[0]).to.deep.include(tracksMock[0]);
      expect(subtitleStreamController.levels[1]).to.deep.include(tracksMock[1]);
    });
  });

  describe('onSubtitleTrackSwitch', function () {
    beforeEach(function () {
      subtitleStreamController.levels = tracksMock;
      subtitleStreamController.clearInterval = sinon.spy();
      subtitleStreamController.setInterval = sinon.spy();

      hls.trigger(Events.SUBTITLE_TRACK_SWITCH, {
        id: 0,
      });
    });

    it('should call setInterval if details available', function () {
      expect(subtitleStreamController.setInterval).to.have.been.calledOnce;
    });

    it('should call clearInterval if no tracks present', function () {
      subtitleStreamController.levels = [];
      hls.trigger(Events.SUBTITLE_TRACK_SWITCH, {
        id: 0,
      });
      expect(subtitleStreamController.clearInterval).to.have.been.calledOnce;
    });

    it('should call clearInterval if new track id === -1', function () {
      hls.trigger(Events.SUBTITLE_TRACK_SWITCH, {
        id: -1,
      });
      expect(subtitleStreamController.clearInterval).to.have.been.calledOnce;
    });
  });

  describe('onSubtitleTrackLoaded', function () {
    beforeEach(function () {
      subtitleStreamController.setInterval = sinon.spy();
      subtitleStreamController.levels = tracksMock;
    });

    // Details are in subtitle-track-controller.js' onSubtitleTrackLoaded handler
    it('should handle the event if the data matches the current track', function () {
      const details = { foo: 'bar', fragments: [] };
      subtitleStreamController.currentTrackId = 1;
      hls.trigger(Events.SUBTITLE_TRACK_LOADED, {
        id: 1,
        details: details,
      });
      expect(subtitleStreamController.levels[1].details).to.equal(details);
    });

    it('should ignore the event if the data does not match the current track', function () {
      const details = { foo: 'bar', fragments: [] };
      subtitleStreamController.currentTrackId = 0;
      hls.trigger(Events.SUBTITLE_TRACK_LOADED, {
        id: 1,
        details,
      });
      expect(subtitleStreamController.levels[0].details).to.not.equal(details);
      expect(subtitleStreamController.setInterval).to.not.have.been.called;
    });

    it('should ignore the event if there are no tracks, or the id is not within the tracks array', function () {
      subtitleStreamController.levels = [];
      subtitleStreamController.trackId = 0;
      const details = { foo: 'bar', fragments: [] };
      hls.trigger(Events.SUBTITLE_TRACK_LOADED, {
        id: 0,
        details,
      });
      expect(subtitleStreamController.levels[0]).to.not.exist;
      expect(subtitleStreamController.setInterval).to.not.have.been.called;
    });
  });

  describe('onMediaSeeking', function () {
    it('nulls fragPrevious when seeking away from fragCurrent', function () {
      subtitleStreamController.fragCurrent = new Fragment(
        PlaylistLevelType.MAIN,
        '',
      );
      subtitleStreamController.fragCurrent.start = 1000;
      subtitleStreamController.fragCurrent.duration = 10;
      subtitleStreamController.fragPrevious = new Fragment(
        PlaylistLevelType.MAIN,
        '',
      );
      subtitleStreamController.onMediaSeeking();
      expect(subtitleStreamController.fragPrevious).to.not.exist;
    });
  });

  describe('_handleFragmentLoadProgress', function () {
    let sandbox;

    beforeEach(function () {
      sandbox = sinon.createSandbox();
    });

    afterEach(function () {
      sandbox.restore();
    });

    function buildEncryptedSubtitleFrag() {
      const frag = new Fragment(PlaylistLevelType.SUBTITLE, '');
      const decryptdata = {
        encrypted: true,
        method: 'AES-128',
        key: new Uint8Array(16),
        iv: new Uint8Array(16),
      };
      // Override Fragment's `decryptdata` and `encrypted` getters with a
      // minimal LevelKey-like stub so we don't need to wire up `levelkeys`.
      Object.defineProperty(frag, 'decryptdata', {
        value: decryptdata,
        configurable: true,
      });
      Object.defineProperty(frag, 'encrypted', {
        value: true,
        configurable: true,
      });
      return frag;
    }

    function buildPart(frag: Fragment) {
      return {
        index: 0,
        fragment: frag,
        start: 0,
        duration: 1,
      } as any;
    }

    function flushPromises() {
      // Drain the .then -> .catch -> .finally microtask chain before asserting.
      let p = Promise.resolve();
      for (let i = 0; i < 5; i++) {
        p = p.then(() => undefined);
      }
      return p;
    }

    function loadProgress(frag, part, payload) {
      // fragContextChanged compares frag against fragCurrent; align them so the
      // controller does not bail out of the post-decrypt continuation.
      subtitleStreamController.fragCurrent = frag;
      subtitleStreamController._handleFragmentLoadProgress({
        frag,
        part,
        payload,
        networkDetails: null,
      });
    }

    it('does nothing when called without a part (full-segment progress)', function () {
      const triggerSpy = sandbox.spy(hls, 'trigger');
      const frag = buildEncryptedSubtitleFrag();
      loadProgress(frag, null, new ArrayBuffer(16));
      expect(triggerSpy).to.not.have.been.calledWith(Events.FRAG_DECRYPTED);
    });

    it('does nothing when the payload is empty', function () {
      const triggerSpy = sandbox.spy(hls, 'trigger');
      const frag = buildEncryptedSubtitleFrag();
      loadProgress(frag, buildPart(frag), new ArrayBuffer(0));
      expect(triggerSpy).to.not.have.been.calledWith(Events.FRAG_DECRYPTED);
    });

    it('does nothing when the fragment is not encrypted', function () {
      const triggerSpy = sandbox.spy(hls, 'trigger');
      const frag = new Fragment(PlaylistLevelType.SUBTITLE, '');
      loadProgress(frag, buildPart(frag), new ArrayBuffer(16));
      expect(triggerSpy).to.not.have.been.calledWith(Events.FRAG_DECRYPTED);
    });

    it('decrypts an encrypted VTT part and triggers FRAG_DECRYPTED with the part', async function () {
      const plaintext = new ArrayBuffer(16);
      const decryptStub = sandbox
        .stub(Decrypter.prototype, 'decrypt')
        .resolves(plaintext);
      const triggerSpy = sandbox.spy(hls, 'trigger');

      const frag = buildEncryptedSubtitleFrag();
      const part = buildPart(frag);
      loadProgress(frag, part, new ArrayBuffer(16));

      await flushPromises();

      expect(decryptStub).to.have.been.calledOnce;
      const calls = triggerSpy.getCalls();
      let decryptedCall;
      for (let i = 0; i < calls.length; i++) {
        if (calls[i].args[0] === Events.FRAG_DECRYPTED) {
          decryptedCall = calls[i];
          break;
        }
      }
      expect(decryptedCall, 'FRAG_DECRYPTED should have been triggered').to
        .exist;
      expect(decryptedCall.args[1].frag).to.equal(frag);
      expect(decryptedCall.args[1].part).to.equal(part);
      expect(decryptedCall.args[1].payload).to.equal(plaintext);
    });

    it('emits ERROR when part decryption fails', async function () {
      sandbox.stub(Decrypter.prototype, 'decrypt').rejects(new Error('boom'));
      const triggerSpy = sandbox.spy(hls, 'trigger');

      const frag = buildEncryptedSubtitleFrag();
      const part = buildPart(frag);
      loadProgress(frag, part, new ArrayBuffer(16));

      await flushPromises();

      const calls = triggerSpy.getCalls();
      let errorCall;
      for (let i = 0; i < calls.length; i++) {
        if (
          calls[i].args[0] === Events.ERROR &&
          calls[i].args[1]?.details === ErrorDetails.FRAG_DECRYPT_ERROR
        ) {
          errorCall = calls[i];
          break;
        }
      }
      expect(errorCall, 'a FRAG_DECRYPT_ERROR should have been emitted').to
        .exist;
      expect(errorCall.args[1].frag).to.equal(frag);
      expect(errorCall.args[1].part).to.equal(part);
      // Note: `fatal` is intentionally not asserted — the error-controller may
      // mutate the event payload to escalate to fatal after our trigger.
      expect(triggerSpy).to.not.have.been.calledWith(Events.FRAG_DECRYPTED);
    });
  });

  describe('empty (silent) subtitle parts', function () {
    // A live subtitle rendition on a part grid publishes a part every
    // PART-TARGET regardless of whether anyone spoke. A part covering silence
    // carries no cues, and a WebVTT body with no cues is legitimately zero
    // bytes once the header lives in EXT-X-MAP. These assert that such a part
    // still advances the controller rather than parking it.
    it('marks a zero-byte subtitle part as loaded', function () {
      const frag = new Fragment(PlaylistLevelType.SUBTITLE, '');
      frag.sn = 1;
      const part = new Part(
        new AttrList({ DURATION: '0.5', URI: 'part/1.vtt' }),
        frag as any,
        '',
        0,
      );
      // What a 200 OK with an empty body leaves behind: no bytes, but a
      // request that demonstrably finished.
      part.stats.loaded = 0;
      part.stats.total = 0;
      part.stats.loading.start = 1;
      part.stats.loading.first = 2;
      part.stats.loading.end = 3;

      expect(
        part.loaded,
        'a silent part that was fetched successfully must count as loaded, ' +
          'otherwise getNextPart keeps selecting it forever',
      ).to.equal(true);

      part.stats.loading.end = 0;
      expect(part.loaded, 'a request still in flight is not loaded').to.equal(
        false,
      );
    });

    it('returns to IDLE after an empty subtitle payload', function () {
      const frag = new Fragment(PlaylistLevelType.SUBTITLE, '');
      frag.sn = 1;
      frag.level = 0;
      subtitleStreamController.currentTrackId = 0;
      subtitleStreamController.tracksBuffered[0] = [];
      // Where _doFragLoad leaves the controller for the whole of a subtitle
      // request: subtitles never transition to PARSING, so this is the state a
      // zero-byte response actually returns into.
      subtitleStreamController.state = State.FRAG_LOADING;

      // A genuinely unprocessable empty payload still releases the scheduler.
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, {
        success: false,
        frag,
        part: null,
        error: new Error('Empty subtitle payload'),
      });

      expect(
        subtitleStreamController.state,
        'an empty payload must not leave the controller parked outside IDLE',
      ).to.equal(State.IDLE);
    });

    it('advances the buffered range across an empty part', function () {
      const frag = new Fragment(PlaylistLevelType.SUBTITLE, '');
      frag.sn = 1;
      frag.level = 0;
      frag.start = 10;
      frag.duration = 2;
      subtitleStreamController.currentTrackId = 0;
      subtitleStreamController.tracksBuffered[0] = [];
      subtitleStreamController.state = State.FRAG_LOADING;

      const silent = { index: 0, fragment: frag, start: 10, duration: 0.5 };
      const spoken = { index: 1, fragment: frag, start: 10.5, duration: 0.5 };

      // A silent part, then one carrying cues: contiguous media either way.
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, {
        success: true,
        frag,
        part: silent,
      });
      expect(
        subtitleStreamController.state,
        'an intermediate part completes its own load operation',
      ).to.equal(State.IDLE);
      subtitleStreamController.state = State.FRAG_LOADING;
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, {
        success: true,
        frag,
        part: spoken,
      });

      const buffered = subtitleStreamController.tracksBuffered[0];
      expect(
        buffered,
        'a silent part covers media time, so it must not split the buffered ' +
          'range — a hole there makes selection stall until the next tick',
      ).to.have.lengthOf(1);
      expect(buffered[0].start).to.equal(10);
      expect(buffered[0].end).to.equal(11);
    });

    it('completes a successful load after its selected track was removed', function () {
      const frag = new Fragment(PlaylistLevelType.SUBTITLE, '');
      frag.sn = 1;
      frag.level = 0;
      subtitleStreamController.currentTrackId = 0;
      subtitleStreamController.tracksBuffered = [];
      subtitleStreamController.state = State.FRAG_LOADING;

      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, {
        success: true,
        frag,
        part: null,
      });

      expect(subtitleStreamController.state).to.equal(State.IDLE);
    });
  });
});
